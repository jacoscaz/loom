import { describe, test } from 'node:test';
import assert from 'node:assert';
import type { Block, EnvelopeBlock, Message, TextBlock, ToolRespBlock } from '@loom/proto';
import type { CompletionQueryOpts, CompletionQueryResult } from '@loom/models';
import { LocalToolServer, ToolServerManager } from '@loom/tools';
import { Agent, type AgentModel, type AgentOpts } from './agent.js';
import { MemoryHistoryStore } from './stores/memory.js';

const text = (data: string): TextBlock => ({ type: 'data', mime: 'text/plain', data });

const envelope = (data: string, session = 'telegram:2002', from = 'telegram:1001'): EnvelopeBlock => ({
  type: 'envelope', kind: 'message', from, session, blocks: [text(data)],
});

const call = (call_id: string, tool: string, params: any, session = 'telegram:2002'): Block => ({
  type: 'tool_call', call_id, tool, params, session,
});

const reply = (...blocks: Block[]): CompletionQueryResult => ({
  messages: [{ role: 'agent', blocks }], input_size: 0, cached_size: 0, output_size: 0,
});

/**
 * Model that replays a script of responses and records every query,
 * snapshotting the history it was given.
 */
class ScriptedModel implements AgentModel {
  queries: (CompletionQueryOpts & { snapshot: Message[] })[] = [];
  constructor(public script: (CompletionQueryResult | Error | (() => Promise<CompletionQueryResult>))[]) {}
  async query(opts: CompletionQueryOpts): Promise<CompletionQueryResult> {
    this.queries.push({ ...opts, snapshot: structuredClone(opts.messages) });
    const next = this.script.shift() ?? reply(text('(script exhausted)'));
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  }
}

/** Tool manager with a fake `chat` server recording outgoing messages. */
const makeTools = async (setup?: (server: LocalToolServer) => void) => {
  const sent: { chat_id: number, text: string, session: string }[] = [];
  const server = new LocalToolServer('chat');
  server.addTool<{ chat_id: number, text: string }>('send', 'Send a message', ({ chat_id, text: t }, session) => {
    sent.push({ chat_id, text: t, session });
    return [text('sent')];
  });
  setup?.(server);
  const manager = new ToolServerManager();
  await manager.addLocalServer(server);
  return { manager, server, sent };
};

const makeAgent = (opts: Omit<AgentOpts, 'store'> & { store?: AgentOpts['store'] }) => {
  return new Agent({ store: new MemoryHistoryStore(), ...opts });
};

const respOf = (message: Message) => message.blocks.filter((b): b is ToolRespBlock => b.type === 'tool_resp');

describe('Agent', () => {

  test('runs a turn: envelope in, tool call out, tool response fed back', async () => {
    const { manager, sent } = await makeTools();
    const model = new ScriptedModel([
      reply(text('thinking about it'), call('c1', 'chat_send', { chat_id: 2002, text: 'hello!' })),
      reply(text('done')),
    ]);
    const agent = makeAgent({ model, tools: manager, system_prompt: 'BASE' });
    await agent.receive(envelope('hi'));
    await agent.idle();

    assert.deepStrictEqual(sent, [{ chat_id: 2002, text: 'hello!', session: 'telegram:2002' }]);
    assert.strictEqual(model.queries.length, 2);

    const [first, second] = model.queries;
    assert.deepStrictEqual(first!.snapshot, [{ role: 'user', blocks: [envelope('hi')] }]);
    assert.strictEqual(first!.session_id, 'telegram:2002');
    assert.match(first!.system_prompt, /^BASE[\s\S]*telegram:2002$/);
    assert.deepStrictEqual(first!.tools.map(t => t.name), ['chat_send']);

    const resp = respOf(second!.snapshot.at(-1)!);
    assert.deepStrictEqual(resp, [{ type: 'tool_resp', call_id: 'c1', response: [text('sent')], session: 'telegram:2002' }]);

    const history = await agent.history('telegram:2002');
    assert.deepStrictEqual(history.map(m => m.role), ['user', 'agent', 'user', 'agent']);
  });

  test('keeps a separate history per session', async () => {
    const { manager } = await makeTools();
    const model = new ScriptedModel([reply(text('a')), reply(text('b'))]);
    const agent = makeAgent({ model, tools: manager, system_prompt: 'BASE' });
    await agent.receive(envelope('to A', 'telegram:1'));
    await agent.receive(envelope('to B', 'telegram:2'));
    await agent.idle();
    assert.deepStrictEqual((await agent.history('telegram:1'))[0], { role: 'user', blocks: [envelope('to A', 'telegram:1')] });
    assert.deepStrictEqual((await agent.history('telegram:2'))[0], { role: 'user', blocks: [envelope('to B', 'telegram:2')] });
    assert.strictEqual((await agent.history('telegram:1')).length, 2);
  });

  test('answers failing and unknown tool calls with error responses', async () => {
    const { manager } = await makeTools((server) => {
      server.addTool<{}>('boom', 'Throws', () => { throw new Error('kaboom'); });
    });
    const model = new ScriptedModel([
      reply(call('c1', 'chat_boom', {}), call('c2', 'no_such_tool', {})),
      reply(text('ok')),
    ]);
    const agent = makeAgent({ model, tools: manager, system_prompt: 'BASE' });
    await agent.receive(envelope('hi'));
    await agent.idle();
    const resps = respOf(model.queries[1]!.snapshot.at(-1)!);
    assert.deepStrictEqual(resps.map(r => r.call_id), ['c1', 'c2']);
    assert.match((resps[0]!.response[0] as TextBlock).data!, /kaboom/);
    assert.match((resps[1]!.response[0] as TextBlock).data!, /no_such_tool not found/);
  });

  test('stops a runaway tool loop after max_steps_per_turn', async () => {
    const { manager, sent } = await makeTools();
    const looping = () => Promise.resolve(reply(call(`c${Math.random()}`, 'chat_send', { chat_id: 1, text: 'again' })));
    const model = new ScriptedModel(Array.from({ length: 10 }, () => looping));
    const agent = makeAgent({ model, tools: manager, system_prompt: 'BASE', max_steps_per_turn: 3 });
    await agent.receive(envelope('hi'));
    await agent.idle();
    assert.strictEqual(model.queries.length, 3);
    assert.strictEqual(sent.length, 3);
  });

  test('folds envelopes that arrive mid-turn into the next query', async () => {
    const { manager } = await makeTools();
    let agent!: Agent;
    const model = new ScriptedModel([
      async () => {
        await agent.receive(envelope('second'));
        return reply(call('c1', 'chat_send', { chat_id: 2002, text: 'x' }));
      },
      reply(text('done')),
    ]);
    agent = makeAgent({ model, tools: manager, system_prompt: 'BASE' });
    await agent.receive(envelope('first'));
    await agent.idle();
    assert.strictEqual(model.queries.length, 2);
    // The late envelope is placed after the agent message it arrived during,
    // not before it, and the tool response still follows its call.
    const tail = model.queries[1]!.snapshot.slice(-3);
    assert.deepStrictEqual(tail.map(m => [m.role, m.blocks.map(b => b.type)]), [
      ['agent', ['tool_call']],
      ['user', ['envelope']],
      ['user', ['tool_resp']],
    ]);
  });

  test('starts a new turn for envelopes that arrive after the last step', async () => {
    const { manager } = await makeTools();
    let agent!: Agent;
    const model = new ScriptedModel([
      async () => {
        await agent.receive(envelope('late'));
        return reply(text('first turn done'));
      },
      reply(text('second turn done')),
    ]);
    agent = makeAgent({ model, tools: manager, system_prompt: 'BASE' });
    await agent.receive(envelope('first'));
    await agent.idle();
    assert.strictEqual(model.queries.length, 2);
    assert.deepStrictEqual(model.queries[1]!.snapshot.at(-1), { role: 'user', blocks: [envelope('late')] });
  });

  test('survives model errors and retries on the next envelope', async () => {
    const { manager } = await makeTools();
    const model = new ScriptedModel([new Error('provider down'), reply(text('back'))]);
    const agent = makeAgent({ model, tools: manager, system_prompt: 'BASE' });
    await agent.receive(envelope('one'));
    await agent.idle();
    await agent.receive(envelope('two'));
    await agent.idle();
    assert.strictEqual(model.queries.length, 2);
    assert.deepStrictEqual(model.queries[1]!.snapshot.map(m => m.role), ['user', 'user']);
    assert.strictEqual((await agent.history('telegram:2002')).at(-1)!.role, 'agent');
  });

  test('resume() runs sessions left with unprocessed messages', async () => {
    const { manager } = await makeTools();
    const store = new MemoryHistoryStore();
    await store.appendIncoming('telegram:7', [envelope('left over', 'telegram:7')]);
    const model = new ScriptedModel([reply(text('caught up'))]);
    const agent = makeAgent({ model, tools: manager, system_prompt: 'BASE', store });
    assert.deepStrictEqual(await agent.resume(), ['telegram:7']);
    await agent.idle();
    assert.strictEqual(model.queries.length, 1);
    assert.deepStrictEqual(await store.pendingSessions(), []);
  });

  test('receive() fails when the envelope cannot be stored', async () => {
    const { manager } = await makeTools();
    const store = new MemoryHistoryStore();
    store.appendIncoming = async () => { throw new Error('db down'); };
    const model = new ScriptedModel([]);
    const agent = makeAgent({ model, tools: manager, system_prompt: 'BASE', store });
    await assert.rejects(agent.receive(envelope('hi')), /db down/);
    assert.strictEqual(model.queries.length, 0);
  });

  test('receives envelopes routed through the tool manager', async () => {
    const { manager, server } = await makeTools();
    const model = new ScriptedModel([reply(text('seen'))]);
    const agent = makeAgent({ model, tools: manager, system_prompt: 'BASE' });
    manager.onEnvelope = async (e) => agent.receive(e);
    await server.sendEnvelope(envelope('via manager'));
    await agent.idle();
    assert.deepStrictEqual(model.queries[0]!.snapshot, [{ role: 'user', blocks: [envelope('via manager')] }]);
  });

});
