import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AudioBlock, EnvelopeBlock, ImageBlock, TextBlock } from '@loom/proto';
import { LocalToolClient, ProcessManager } from '@loom/tools';
import { waitFor } from '@loom/utils';
import { TelegramToolServer } from './server.js';
import { type TelegramMessage, type TelegramUpdate } from './types/message.js';

const SESSION = 'test-session';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const OGG = Buffer.from('OggS fake voice');

const silentLogger = { error: () => {}, warn: () => {}, info: () => {} };

const text = (data: string): TextBlock => ({ type: 'data', mime: 'text/plain', data });

/**
 * In-memory Bot API. `getUpdates` hands out queued batches; once the queue
 * is empty it behaves like a long poll and hangs until aborted.
 */
class FakeBotApi {

  calls: { method: string, body: any }[] = [];
  batches: TelegramUpdate[][] = [];
  files: Record<string, Buffer> = {};
  #real_fetch = globalThis.fetch;

  install() {
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      const file = url.match(/\/file\/botTOKEN\/(.+)$/);
      if (file) {
        const bytes = this.files[file[1]!];
        return bytes ? new Response(new Uint8Array(bytes)) : new Response('nope', { status: 404 });
      }
      const method = url.split('/').pop()!;
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      this.calls.push({ method, body });
      switch (method) {
        case 'getUpdates': {
          const batch = this.batches.shift();
          if (batch) return this.#ok(batch);
          return new Promise((_resolve, reject) => {
            const signal: AbortSignal | undefined = init.signal;
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        case 'getFile':
          return this.files[body.file_id] ? this.#ok({ file_path: body.file_id }) : this.#ok({});
        case 'getMe':
          return this.#ok({ id: 42, is_bot: true, first_name: 'Loom', username: 'loom_bot' });
        case 'sendMessage':
          return this.#ok({ message_id: 7, chat: { id: body.chat_id, type: 'private' }, date: 0, text: body.text });
        default:
          return this.#ok({ message_id: 8 });
      }
    }) as typeof fetch;
  }

  uninstall() {
    globalThis.fetch = this.#real_fetch;
  }

  #ok(result: unknown) {
    return new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
  }

  of(method: string) {
    return this.calls.filter(c => c.method === method);
  }

}

const message = (update_id: number, partial: Partial<TelegramMessage>, from_id = 1001, chat_id = 2002): TelegramUpdate => ({
  update_id,
  message: {
    message_id: update_id,
    from: { id: from_id, is_bot: false, first_name: 'Ada' },
    chat: { id: chat_id, type: 'private' },
    date: 0,
    ...partial,
  },
});

describe('TelegramToolServer', () => {

  let api: FakeBotApi;
  let server: TelegramToolServer;
  let envelopes: EnvelopeBlock[];
  let media_dir: string;

  const makeServer = (opts: { allowed_user_ids?: number[] } = {}) => {
    server = new TelegramToolServer({ api_token: 'TOKEN', logger: silentLogger, media_dir, ...opts });
    const client = new LocalToolClient(server);
    client.onEnvelope = async (envelope) => { envelopes.push(envelope); };
    return server;
  };

  beforeEach(async () => {
    api = new FakeBotApi();
    api.install();
    envelopes = [];
    media_dir = await mkdtemp(join(tmpdir(), 'loom-telegram-'));
  });

  afterEach(async () => {
    await server?.stop();
    api.uninstall();
    await rm(media_dir, { recursive: true, force: true });
  });

  test('declares its tools', () => {
    const names = makeServer().listTools().map(d => d.name).sort();
    assert.deepStrictEqual(names, ['file', 'me', 'send_document', 'send_photo', 'send_text', 'send_voice']);
  });

  test('tools are namespaced as telegram_* by the manager', async () => {
    const manager = new ProcessManager();
    await manager.addLocalServer(makeServer());
    assert.ok(manager.listTools().some(d => d.name === 'telegram_send_text'));
  });

  test('send_text sends a message and reports its id', async () => {
    const result = await makeServer().callTool('send_text', { text: 'hello', chat_id: 2002 }, SESSION);
    assert.deepStrictEqual(result, [text('Sent — message_id: 7')]);
    assert.deepStrictEqual(api.of('sendMessage')[0]!.body, { chat_id: 2002, text: 'hello' });
  });

  test('send_text rejects malformed params without calling the API', async () => {
    const result = await makeServer().callTool('send_text', { text: 'hello' }, SESSION);
    assert.match((result[0] as TextBlock).data!, /^Invalid params/);
    assert.strictEqual(api.of('sendMessage').length, 0);
  });

  test('me reports the bot identity', async () => {
    const result = await makeServer().callTool('me', {}, SESSION);
    assert.deepStrictEqual(result, [text('Bot: @loom_bot (id 42, "Loom")')]);
  });

  test('file downloads media into the media directory', async () => {
    api.files['abc'] = JPEG;
    const result = await makeServer().callTool('file', { file_id: 'abc', file_name: 'pic.jpg' }, SESSION);
    const path = (result[0] as TextBlock).data!.replace(/^File saved to /, '');
    assert.ok(path.startsWith(media_dir) && path.endsWith('.jpg'), path);
    assert.deepStrictEqual(await readFile(path), JPEG);
  });

  test('API errors surface as error blocks', async () => {
    api.uninstall();
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, description: 'chat not found' }))) as typeof fetch;
    const result = await makeServer().callTool('send_text', { text: 'x', chat_id: 1 }, SESSION);
    assert.match((result[0] as TextBlock).data!, /error: .*chat not found/);
  });

  test('forwards text messages as envelopes keyed by sender and chat', async () => {
    api.batches.push([message(100, { text: 'hi there' })]);
    makeServer().start();
    await waitFor(() => envelopes.length === 1);
    assert.deepStrictEqual(envelopes[0], {
      type: 'envelope',
      kind: 'message',
      from: 'telegram:1001',
      session: 'telegram:2002',
      blocks: [text('hi there')],
    });
  });

  test('confirms updates only after forwarding them', async () => {
    api.batches.push([message(100, { text: 'a' }), message(101, { text: 'b' })]);
    makeServer().start();
    await waitFor(() => api.of('getUpdates').length === 2);
    assert.strictEqual(api.of('getUpdates')[0]!.body.offset, undefined);
    assert.strictEqual(api.of('getUpdates')[1]!.body.offset, 102);
    assert.strictEqual(envelopes.length, 2);
  });

  test('inlines the largest photo size with its caption', async () => {
    api.files['big'] = JPEG;
    api.batches.push([message(100, {
      caption: 'look',
      photo: [{ file_id: 'small', width: 10, height: 10 }, { file_id: 'big', width: 100, height: 100 }],
    })]);
    makeServer().start();
    await waitFor(() => envelopes.length === 1);
    const [block] = envelopes[0]!.blocks as ImageBlock[];
    assert.strictEqual(block!.mime, 'image/jpeg');
    assert.deepStrictEqual(Buffer.from(block!.data!), JPEG);
    assert.deepStrictEqual(block!.caption, text('look'));
  });

  test('inlines voice notes as untranscribed audio/ogg blocks', async () => {
    api.files['voice'] = OGG;
    api.batches.push([message(100, { voice: { file_id: 'voice', duration: 3 } })]);
    makeServer().start();
    await waitFor(() => envelopes.length === 1);
    const [block] = envelopes[0]!.blocks as AudioBlock[];
    assert.strictEqual(block!.mime, 'audio/ogg');
    assert.strictEqual(block!.duration, 3);
    assert.strictEqual(block!.transcription, undefined);
    assert.deepStrictEqual(Buffer.from(block!.data!), OGG);
  });

  test('describes documents so the agent can fetch them with the file tool', async () => {
    api.batches.push([message(100, { document: { file_id: 'doc1', file_name: 'report.pdf' } })]);
    makeServer().start();
    await waitFor(() => envelopes.length === 1);
    assert.deepStrictEqual(envelopes[0]!.blocks, [text('[document: report.pdf, file_id: doc1]')]);
  });

  test('drops messages from users outside the allowlist', async () => {
    api.batches.push([message(100, { text: 'intruder' }, 666), message(101, { text: 'friend' }, 1001)]);
    makeServer({ allowed_user_ids: [1001] }).start();
    await waitFor(() => api.of('getUpdates').length === 2);
    assert.deepStrictEqual(envelopes.map(e => e.from), ['telegram:1001']);
  });

  test('ignores updates without a message or sender', async () => {
    const no_sender = message(101, { text: 'anon' });
    delete no_sender.message!.from;
    api.batches.push([{ update_id: 100 }, no_sender]);
    makeServer().start();
    await waitFor(() => api.of('getUpdates').length === 2);
    assert.strictEqual(envelopes.length, 0);
  });

  test('stop() aborts an in-flight long poll', async () => {
    makeServer().start();
    await waitFor(() => api.of('getUpdates').length === 1);
    await server.stop();
    // Restartable after stopping.
    server.start();
    await waitFor(() => api.of('getUpdates').length === 2);
  });

});
