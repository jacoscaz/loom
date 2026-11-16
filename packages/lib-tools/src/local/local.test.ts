import { describe, test } from "node:test";
import assert from "node:assert";
import type { EnvelopeBlock, TextBlock } from "@loom/proto";
import { LocalToolServer } from "./server.js";
import { LocalToolClient } from "./client.js";

const SESSION = 'test-session';

const text = (data: string): TextBlock => ({ type: 'data', mime: 'text/plain', data });

const envelope = (data: string): EnvelopeBlock => ({
  type: 'envelope',
  kind: 'message',
  from: 'test:sender',
  session: SESSION,
  blocks: [text(data)],
});

const makeServer = () => {
  const server = new LocalToolServer('local');
  server.addTool<{ text: string }>('echo', 'Echoes the given text back', async ({ text: t }) => [text(t)]);
  server.addTool<{ a: number, b: number }>('add', 'Adds two numbers', ({ a, b }) => [text(String(a + b))]);
  server.addTool<{}>('fail', 'Always throws', () => { throw new Error('boom'); });
  return server;
};

describe("LocalToolServer", () => {

  test("exposes its name", () => {
    assert.strictEqual(new LocalToolServer('my-server').name, 'my-server');
  });

  test("reports registered tools via hasTool()", () => {
    const server = makeServer();
    assert.strictEqual(server.hasTool('echo'), true);
    assert.strictEqual(server.hasTool('add'), true);
    assert.strictEqual(server.hasTool('missing'), false);
  });

  test("lists a declaration for every registered tool", () => {
    const server = makeServer();
    const decls = server.listTools();
    assert.deepStrictEqual(decls.map(d => d.name).sort(), ['add', 'echo', 'fail']);
    for (const decl of decls) {
      assert.strictEqual(decl.type, 'tool_decl');
      assert.strictEqual(typeof decl.description, 'string');
      assert.ok(decl.params_schema, `missing params_schema for ${decl.name}`);
    }
  });

  test("derives the params schema from the handler's type parameter", () => {
    const decl = makeServer().listTools().find(d => d.name === 'add');
    assert.ok(decl);
    assert.strictEqual(decl.description, 'Adds two numbers');
    assert.strictEqual(decl.params_schema.type, 'object');
    assert.deepStrictEqual(Object.keys(decl.params_schema.properties).sort(), ['a', 'b']);
  });

  test("returns copies of declarations, not internal state", () => {
    const server = makeServer();
    const [first] = server.listTools();
    assert.ok(first);
    first.description = 'mutated';
    assert.notStrictEqual(server.listTools().find(d => d.name === first.name)?.description, 'mutated');
  });

  test("replaces a tool registered twice under the same name", async () => {
    const server = new LocalToolServer('local');
    server.addTool<{}>('t', 'first', () => [text('first')]);
    server.addTool<{}>('t', 'second', () => [text('second')]);
    assert.deepStrictEqual(await server.callTool('t', {}, SESSION), [text('second')]);
  });

  test("invokes async handlers and returns their result", async () => {
    assert.deepStrictEqual(await makeServer().callTool('echo', { text: 'hi' }, SESSION), [text('hi')]);
  });

  test("invokes sync handlers and returns their result", async () => {
    assert.deepStrictEqual(await makeServer().callTool('add', { a: 2, b: 3 }, SESSION), [text('5')]);
  });

  test("returns an error block rather than throwing when a handler throws", async () => {
    const result = await makeServer().callTool('fail', {}, SESSION);
    assert.strictEqual(result.length, 1);
    assert.match((result[0] as TextBlock).data!, /error: .*boom/);
  });

  test("returns an error block rather than throwing for unknown tools", async () => {
    const result = await makeServer().callTool('missing', {}, SESSION);
    assert.deepStrictEqual(result, [text('tool not found')]);
  });

  test("passes the calling session to the handler", async () => {
    const server = new LocalToolServer('local');
    server.addTool<{}>('whoami', 'Returns the calling session', (_params, session) => [text(session)]);
    assert.deepStrictEqual(await server.callTool('whoami', {}, 'session-a'), [text('session-a')]);
    assert.deepStrictEqual(await server.callTool('whoami', {}, 'session-b'), [text('session-b')]);
  });

  test("rejects params that do not match the declared type without calling the handler", async () => {
    const server = new LocalToolServer('local');
    let calls = 0;
    server.addTool<{ text: string }>('echo', 'Echo', ({ text: t }) => { calls += 1; return [text(t)]; });
    const result = await server.callTool('echo', { text: 42 }, SESSION);
    assert.strictEqual(calls, 0);
    assert.match((result[0] as TextBlock).data!, /^Invalid params/);
  });

});

describe("LocalToolClient", () => {

  test("mirrors the wrapped server's name", () => {
    const client = new LocalToolClient(makeServer());
    assert.strictEqual(client.name, 'local');
  });

  test("delegates hasTool(), listTools() and callTool() to the server", async () => {
    const server = makeServer();
    const client = new LocalToolClient(server);
    assert.strictEqual(client.hasTool('echo'), true);
    assert.strictEqual(client.hasTool('missing'), false);
    assert.deepStrictEqual(client.listTools(), server.listTools());
    assert.deepStrictEqual(await client.callTool('echo', { text: 'via client' }, SESSION), [text('via client')]);
  });

  test("forwards envelopes sent by the server to the client's onEnvelope", async () => {
    const server = makeServer();
    const client = new LocalToolClient(server);
    const received: { envelope: EnvelopeBlock, client: unknown }[] = [];
    client.onEnvelope = async (envelope, c) => { received.push({ envelope, client: c }); };
    await server.sendEnvelope(envelope('hello'));
    assert.strictEqual(received.length, 1);
    assert.deepStrictEqual(received[0]!.envelope, envelope('hello'));
    assert.strictEqual(received[0]!.client, client);
  });

  test("stop() resolves", async () => {
    await new LocalToolClient(makeServer()).stop();
  });

});
