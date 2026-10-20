import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { ProcessManager } from "../manager/manager.js";
import { waitFor } from "../test-utils.js";

const FIXTURE = fileURLToPath(new URL('./fixtures/calc-process.js', import.meta.url));

const TIMEOUT = { timeout: 3_000 };

describe("ProcessIO <-> ProcessManager end-to-end", () => {

  let manager: ProcessManager;

  beforeEach(async () => {
    manager = new ProcessManager({ onEnvelopeBlock: async () => { } });
    manager.start('calc', process.execPath, [FIXTURE]);
    await waitFor(() => manager.listTools().length === 3);
  });

  afterEach(async () => {
    await manager.stop();
  });

  test("registerTool sends a tool_decl for each registered tool", TIMEOUT, () => {
    const tools = manager.listTools();
    assert.deepStrictEqual(tools.map((t) => t.name).sort(), ['calc_add', 'calc_fail', 'calc_upper']);
    const add = tools.find((t) => t.name === 'calc_add')!;
    assert.strictEqual(add.type, 'tool_decl');
    assert.strictEqual(add.description, 'Adds two numbers');
  });

  test("tool_decl carries a JSON schema derived from the params type", TIMEOUT, () => {
    const add = manager.listTools().find((t) => t.name === 'calc_add')!;
    assert.strictEqual(add.params_schema.type, 'object');
    assert.strictEqual(add.params_schema.properties.a.type, 'number');
    assert.strictEqual(add.params_schema.properties.b.type, 'number');
    assert.deepStrictEqual([...add.params_schema.required].sort(), ['a', 'b']);
  });

  test("tool call round-trip through ProcessIO", TIMEOUT, async () => {
    assert.deepStrictEqual(await manager.callTool('calc_add', { a: 2, b: 3 }), [
      { type: 'data', mime: 'text/plain', data: '5' },
    ]);
    assert.deepStrictEqual(await manager.callTool('calc_upper', { text: 'loom' }), [
      { type: 'data', mime: 'text/plain', data: 'LOOM' },
    ]);
  });

  test("concurrent tool calls all resolve with the right results", TIMEOUT, async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => manager.callTool('calc_add', { a: i, b: i })),
    );
    assert.deepStrictEqual(results.map((r) => r[0]?.data), Array.from({ length: 10 }, (_, i) => String(i * 2)));
  });

  test("invalid params produce an error response", TIMEOUT, async () => {
    const resp = await manager.callTool('calc_add', { a: 'two', b: 3 });
    assert.deepStrictEqual(resp, [
      { type: 'data', mime: 'text/plain', data: 'error: Error: Invalid params' },
    ]);
  });

  test("handler errors produce an error response", TIMEOUT, async () => {
    const resp = await manager.callTool('calc_fail', {});
    assert.deepStrictEqual(resp, [
      { type: 'data', mime: 'text/plain', data: 'error: Error: boom' },
    ]);
  });

});
