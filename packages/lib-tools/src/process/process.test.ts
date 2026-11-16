import { after, before, describe, test } from "node:test";
import assert from "node:assert";
import type { TextBlock } from "@loom/proto";
import { waitFor } from "@loom/utils";
import { ProcessToolClient } from "./client.js";
import { ECHO_SERVER } from "../test-fixtures/paths.js";

const SESSION = 'test-session';

const text = (data: string): TextBlock => ({ type: 'data', mime: 'text/plain', data });

const spawnEcho = (name = 'echo') => new ProcessToolClient(name, process.execPath, [ECHO_SERVER]);

describe("ProcessToolClient (not started)", () => {

  test("exposes its name and is not running", () => {
    const client = spawnEcho('idle');
    assert.strictEqual(client.name, 'idle');
    assert.strictEqual(client.running, false);
  });

  test("rejects tool calls", async () => {
    await assert.rejects(spawnEcho().callTool('echo', { text: 'x' }, SESSION), /not running/);
  });

  test("stop() is a no-op", async () => {
    await spawnEcho().stop();
  });

});

describe("ProcessToolClient <-> ProcessToolServer", () => {

  let client: ProcessToolClient;

  before(() => {
    client = spawnEcho();
    client.start();
  });

  after(async () => {
    await client.stop();
  });

  test("is running after start()", () => {
    assert.strictEqual(client.running, true);
  });

  test("round-trips a tool call", async () => {
    assert.deepStrictEqual(await client.callTool('echo', { text: 'hello' }, SESSION), [text('hello')]);
  });

  test("preserves non-ASCII payloads", async () => {
    const payload = 'héllo wörld 🧶\nwith a newline';
    assert.deepStrictEqual(await client.callTool('echo', { text: payload }, SESSION), [text(payload)]);
  });

  test("matches concurrent responses to their calls", async () => {
    const [slow, fast] = await Promise.all([
      client.callTool('sleep', { ms: 100 }, SESSION),
      client.callTool('echo', { text: 'fast' }, SESSION),
    ]);
    assert.deepStrictEqual(slow, [text('slept 100')]);
    assert.deepStrictEqual(fast, [text('fast')]);
  });

  test("carries the calling session across the process boundary", async () => {
    assert.deepStrictEqual(await client.callTool('whoami', {}, 'session-a'), [text('session-a')]);
  });

  test("surfaces handler errors as an error block", async () => {
    const result = await client.callTool('fail', {}, SESSION);
    assert.match((result[0] as TextBlock).data!, /error: .*boom/);
  });

  test("returns an error block for unknown tools", async () => {
    assert.deepStrictEqual(await client.callTool('missing', {}, SESSION), [text('tool not found')]);
  });

  test("learns the server's tool declarations", async () => {
    await waitFor(() => client.hasTool('echo'));
    assert.deepStrictEqual(client.listTools().map(d => d.name).sort(), ['echo', 'exit', 'fail', 'sleep', 'whoami']);
  });

});

describe("ProcessToolClient lifecycle", () => {

  test("stop() kills the child and prevents further calls", async () => {
    const client = spawnEcho();
    client.start();
    try {
      assert.deepStrictEqual(await client.callTool('echo', { text: 'up' }, SESSION), [text('up')]);
    } finally {
      await client.stop();
    }
    assert.strictEqual(client.running, false);
    await assert.rejects(client.callTool('echo', { text: 'x' }, SESSION), /not running/);
  });

  test("rejects pending calls when the process exits", async () => {
    const client = spawnEcho();
    client.start();
    try {
      await assert.rejects(client.callTool('exit', {}, SESSION), /process exited/);
    } finally {
      await client.stop();
    }
  });

});
