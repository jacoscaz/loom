import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert';
import type { Block, EnvelopeBlock, ImageBlock, Message, TextBlock } from '@loom/proto';
import type { HistoryStore } from './store.js';

/**
 * Behavioural contract shared by every HistoryStore implementation.
 * `setup` returns a fresh, empty store and a teardown function.
 */
export const historyStoreContract = (
  name: string,
  setup: () => Promise<{ store: HistoryStore, teardown: () => Promise<void> }>,
  opts: { skip?: string | false } = {},
) => {

  const text = (data: string): TextBlock => ({ type: 'data', mime: 'text/plain', data });
  const envelope = (data: string, session = 's1'): EnvelopeBlock => ({
    type: 'envelope', kind: 'message', from: 'telegram:1', session, blocks: [text(data)],
  });
  const agentSays = (data: string): Message => ({ role: 'agent', blocks: [text(data)] });
  const roles = (history: Message[]) => history.map(m => `${m.role}:${(m.blocks[0] as any).blocks?.[0]?.data ?? (m.blocks[0] as any).data ?? m.blocks[0]!.type}`);

  const withStore = (fn: (store: HistoryStore) => Promise<void>) => async (_t: TestContext) => {
    const { store, teardown } = await setup();
    try {
      await fn(store);
    } finally {
      await teardown();
    }
  };

  describe(`HistoryStore contract: ${name}`, { skip: opts.skip }, () => {

    test('starts empty', withStore(async (store) => {
      assert.deepStrictEqual(await store.history('s1'), []);
      assert.deepStrictEqual(await store.pendingSessions(), []);
      assert.strictEqual(await store.activate('s1', async () => { throw new Error('must not be called'); }), false);
    }));

    test('incoming messages are pending until activated', withStore(async (store) => {
      await store.appendIncoming('s1', [envelope('hi')]);
      await store.appendIncoming('s2', [envelope('yo', 's2')]);
      assert.deepStrictEqual((await store.pendingSessions()).sort(), ['s1', 's2']);
      assert.deepStrictEqual(await store.history('s1'), [{ role: 'user', blocks: [envelope('hi')] }]);
    }));

    test('activation passes the history and stores the output', withStore(async (store) => {
      await store.appendIncoming('s1', [envelope('hi')]);
      let seen: Message[] = [];
      const more = await store.activate('s1', async (history) => {
        seen = history;
        return [{ message: agentSays('hello'), processed: true }];
      });
      assert.strictEqual(more, true);
      assert.deepStrictEqual(seen, [{ role: 'user', blocks: [envelope('hi')] }]);
      assert.deepStrictEqual(await store.history('s1'), [{ role: 'user', blocks: [envelope('hi')] }, agentSays('hello')]);
      assert.deepStrictEqual(await store.pendingSessions(), []);
      assert.strictEqual(await store.activate('s1', async () => []), false);
    }));

    test('unprocessed outputs trigger another activation', withStore(async (store) => {
      await store.appendIncoming('s1', [envelope('hi')]);
      const resp: Block = { type: 'tool_resp', call_id: 'c1', response: [text('ok')], session: 's1' };
      await store.activate('s1', async () => [
        { message: { role: 'agent', blocks: [{ type: 'tool_call', call_id: 'c1', tool: 't', params: { a: 1 }, session: 's1' }] }, processed: true },
        { message: { role: 'user', blocks: [resp] }, processed: false },
      ]);
      assert.deepStrictEqual(await store.pendingSessions(), ['s1']);
      let seen: Message[] = [];
      assert.strictEqual(await store.activate('s1', async (h) => { seen = h; return [{ message: agentSays('done'), processed: true }]; }), true);
      assert.deepStrictEqual(seen.at(-1), { role: 'user', blocks: [resp] });
      assert.deepStrictEqual(await store.pendingSessions(), []);
    }));

    test('messages arriving during an activation are ordered after its output', withStore(async (store) => {
      await store.appendIncoming('s1', [envelope('first')]);
      await store.activate('s1', async () => {
        await store.appendIncoming('s1', [envelope('second')]);
        return [{ message: agentSays('reply to first'), processed: true }];
      });
      assert.deepStrictEqual(roles(await store.history('s1')), ['user:first', 'agent:reply to first', 'user:second']);
      // ...and are still pending.
      assert.deepStrictEqual(await store.pendingSessions(), ['s1']);
      await store.activate('s1', async () => [{ message: agentSays('reply to second'), processed: true }]);
      assert.deepStrictEqual(roles(await store.history('s1')), ['user:first', 'agent:reply to first', 'user:second', 'agent:reply to second']);
    }));

    test('a failing handler changes nothing', withStore(async (store) => {
      await store.appendIncoming('s1', [envelope('hi')]);
      await assert.rejects(store.activate('s1', async () => { throw new Error('model down'); }), /model down/);
      assert.deepStrictEqual(await store.pendingSessions(), ['s1']);
      assert.deepStrictEqual(await store.history('s1'), [{ role: 'user', blocks: [envelope('hi')] }]);
    }));

    test('sessions are isolated', withStore(async (store) => {
      await store.appendIncoming('s1', [envelope('one', 's1')]);
      await store.appendIncoming('s2', [envelope('two', 's2')]);
      await store.activate('s1', async () => [{ message: agentSays('for one'), processed: true }]);
      assert.deepStrictEqual(await store.pendingSessions(), ['s2']);
      assert.deepStrictEqual(roles(await store.history('s2')), ['user:two']);
    }));

    test('round-trips binary media', withStore(async (store) => {
      const image: ImageBlock = { type: 'data', mime: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]), caption: text('pic') };
      const env: EnvelopeBlock = { ...envelope('x'), blocks: [image] };
      await store.appendIncoming('s1', [env]);
      const [message] = await store.history('s1');
      const stored = (message!.blocks[0] as EnvelopeBlock).blocks[0] as ImageBlock;
      assert.ok(Buffer.isBuffer(stored.data), 'image data must come back as a Buffer');
      assert.deepStrictEqual(stored, image);
    }));

  });

};
