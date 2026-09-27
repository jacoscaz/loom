import { test } from 'node:test';
import assert from 'node:assert';
import { TelegramClient } from './client.js';
import { processUpdateWithRetry } from './notifier.js';
import { type TelegramUpdate } from './types/message.js';

// ── client: at-least-once offset semantics ──────────────────────────────────

const apiJson = (result: unknown) =>
  new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });

test('fetchUpdates does not advance the offset; confirmUpdates does', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return apiJson([{ update_id: 100 }, { update_id: 101 }]);
  }) as any;
  try {
    const client = new TelegramClient('TESTTOKEN');
    const updates = await client.fetchUpdates(1);
    assert.strictEqual(updates.length, 2);
    // First call carries no offset — nothing confirmed yet.
    assert.strictEqual(calls[0].body.offset, undefined);

    // Calling again without confirming MUST redeliver the same updates.
    await client.fetchUpdates(1);
    assert.strictEqual(calls[1].body.offset, undefined);

    // Confirming up to 101 advances the offset to 102.
    client.confirmUpdates(101);
    await client.fetchUpdates(1);
    assert.strictEqual(calls[2].body.offset, 102);
    assert.ok(calls[2].url.includes('/getUpdates'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── processUpdateWithRetry: bounded retries, loud dead-letter ───────────────

const fakeUpdate = { update_id: 7 } as TelegramUpdate;
const silentSleep = async () => {};

test('processUpdateWithRetry: success on first attempt', async () => {
  let calls = 0;
  const outcome = await processUpdateWithRetry(
    { handleUpdate: async () => { calls++; }, log: fakeLogger(), sleep: silentSleep },
    fakeUpdate,
  );
  assert.strictEqual(outcome, 'processed');
  assert.strictEqual(calls, 1);
});

test('processUpdateWithRetry: transient failure then success', async () => {
  let calls = 0;
  const outcome = await processUpdateWithRetry(
    {
      handleUpdate: async () => { calls++; if (calls < 3) throw new Error('db hiccup'); },
      log: fakeLogger(),
      sleep: silentSleep,
    },
    fakeUpdate,
  );
  assert.strictEqual(outcome, 'processed');
  assert.strictEqual(calls, 3);
});

test('processUpdateWithRetry: permanently poisoned update dead-letters after max attempts', async () => {
  let calls = 0;
  const outcome = await processUpdateWithRetry(
    {
      handleUpdate: async () => { calls++; throw new Error('poison'); },
      log: fakeLogger(),
      max_attempts: 3,
      sleep: silentSleep,
    },
    fakeUpdate,
  );
  assert.strictEqual(outcome, 'dead-lettered');
  assert.strictEqual(calls, 3); // bounded, no infinite loop
});

// ── client: outbound media (multipart sendPhoto / sendDocument) ─────────────

test('sendPhoto posts multipart form with chat_id and caption to /sendPhoto', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const photoPath = join(tmpdir(), `test-photo-${Date.now()}.png`);
  await writeFile(photoPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic

  let captured: { url: string; body: FormData } | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url: String(url), body: init.body as FormData };
    return apiJson({ message_id: 42 });
  }) as any;
  try {
    const client = new TelegramClient('TESTTOKEN');
    const message = await client.sendPhoto(123, photoPath, 'a caption');
    assert.strictEqual(message.message_id, 42);
    const form = captured!.body;
    assert.ok(captured!.url.includes('/sendPhoto'));
    assert.strictEqual(form.get('chat_id'), '123');
    assert.strictEqual(form.get('caption'), 'a caption');
    const file = form.get('photo') as File;
    assert.ok(file instanceof File);
    assert.strictEqual(file.name, photoPath.split('/').pop());
    assert.strictEqual(file.type, 'image/png');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('sendDocument posts multipart form to /sendDocument with fallback mime', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const docPath = join(tmpdir(), `test-doc-${Date.now()}`);
  await writeFile(docPath, Buffer.from('arbitrary bytes'));

  let captured: { url: string; body: FormData } | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url: String(url), body: init.body as FormData };
    return apiJson({ message_id: 43 });
  }) as any;
  try {
    const client = new TelegramClient('TESTTOKEN');
    const message = await client.sendDocument(456, docPath);
    assert.strictEqual(message.message_id, 43);
    const form = captured!.body;
    assert.ok(captured!.url.includes('/sendDocument'));
    assert.strictEqual(form.get('chat_id'), '456');
    assert.strictEqual(form.get('caption'), null);
    const file = form.get('document') as File;
    assert.ok(file instanceof File);
    assert.strictEqual(file.type, 'application/octet-stream');
  } finally {
    globalThis.fetch = realFetch;
  }
});

const fakeLogger = () => ({
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => fakeLogger(),
} as any);
