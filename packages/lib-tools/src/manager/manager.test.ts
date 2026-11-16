import { describe, test } from "node:test";
import assert from "node:assert";
import type { TextBlock } from "@loom/proto";
import { ToolServerManager } from "./manager.js";
import { LocalToolServer } from "../local/server.js";
import { ECHO_SERVER } from "../test-fixtures/paths.js";

const SESSION = 'test-session';

const text = (data: string): TextBlock => ({ type: 'data', mime: 'text/plain', data });

const makeServer = (name: string) => {
  const server = new LocalToolServer(name);
  server.addTool<{ text: string }>('echo', `Echo from ${name}`, ({ text: t }) => [text(`${name}:${t}`)]);
  return server;
};

describe("ToolServerManager", () => {

  test("lists no tools when empty", () => {
    assert.deepStrictEqual(new ToolServerManager().listTools(), []);
  });

  test("namespaces tools as <server>_<tool>", async () => {
    const manager = new ToolServerManager();
    await manager.addLocalServer(makeServer('alpha'));
    await manager.addLocalServer(makeServer('beta'));
    const decls = manager.listTools();
    assert.deepStrictEqual(decls.map(d => d.name).sort(), ['alpha_echo', 'beta_echo']);
    assert.strictEqual(decls.find(d => d.name === 'alpha_echo')?.description, 'Echo from alpha');
  });

  test("routes calls to the owning server using the un-prefixed tool name", async () => {
    const manager = new ToolServerManager();
    await manager.addLocalServer(makeServer('alpha'));
    await manager.addLocalServer(makeServer('beta'));
    assert.deepStrictEqual(await manager.callTool('alpha_echo', { text: 'x' }, SESSION), [text('alpha:x')]);
    assert.deepStrictEqual(await manager.callTool('beta_echo', { text: 'y' }, SESSION), [text('beta:y')]);
  });

  test("throws for unknown tools", async () => {
    const manager = new ToolServerManager();
    await manager.addLocalServer(makeServer('alpha'));
    await assert.rejects(manager.callTool('echo', {}, SESSION), /tool echo not found/);
    await assert.rejects(manager.callTool('alpha_missing', {}, SESSION), /not found/);
  });

  test("stop() stops every registered server", async () => {
    const manager = new ToolServerManager();
    const server = makeServer('alpha');
    let stopped = 0;
    server.stop = () => { stopped += 1; };
    await manager.addLocalServer(server);
    await manager.stop();
    assert.strictEqual(stopped, 1);
  });

  test("starts process servers and exposes their tools", async () => {
    const manager = new ToolServerManager();
    try {
      await manager.addProcessServer('proc', process.execPath, [ECHO_SERVER]);
      assert.ok(manager.listTools().some(d => d.name === 'proc_echo'));
      assert.deepStrictEqual(await manager.callTool('proc_echo', { text: 'hi' }, SESSION), [text('hi')]);
    } finally {
      await manager.stop();
    }
  });

});
