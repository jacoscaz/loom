import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { ProcessManager } from "./manager.js";
import type { Process } from "./process.js";
import type { EnvelopeBlock } from "../blocks/index.js";
import { waitFor } from "../test-utils.js";

const FIXTURE = fileURLToPath(new URL('./fixtures/echo-process.js', import.meta.url));


// Hard cap per test so that lost messages fail fast instead of hanging the run.
const TIMEOUT = { timeout: 3_000 };


describe("ProcessManager <-> child process I/O", () => {

  let manager: ProcessManager;
  let envelopes: { block: EnvelopeBlock, process: Process }[];

  beforeEach(async () => {
    envelopes = [];
    manager = new ProcessManager({
      onEnvelopeBlock: async (block, process) => {
        envelopes.push({ block, process });
      },
    });
    manager.start('echo', process.execPath, [FIXTURE]);
    await waitFor(() => manager.listTools().length === 4);
  });

  afterEach(async () => {
    await manager.stop();
  });

  test("registers tools declared by the child, namespaced by process name", TIMEOUT, () => {
    const names = manager.listTools().map((t) => t.name).sort();
    assert.deepStrictEqual(names, ['echo_burst', 'echo_crash', 'echo_echo', 'echo_envelope']);
    const echo = manager.listTools().find((t) => t.name === 'echo_echo')!;
    assert.strictEqual(echo.type, 'tool_decl');
    assert.strictEqual(echo.description, 'Echoes params back as text');
    assert.deepStrictEqual(echo.params_schema, { type: 'object' });
  });

  test("tool call round-trip returns the child's response", TIMEOUT, async () => {
    const params = { hello: 'world', n: 42 };
    const resp = await manager.callTool('echo_echo', params);
    assert.deepStrictEqual(resp, [
      { type: 'data', mime: 'text/plain', data: JSON.stringify(params) },
    ]);
  });

  test("concurrent tool calls are matched to their responses by call_id", TIMEOUT, async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => manager.callTool('echo_echo', { i })),
    );
    results.forEach((resp, i) => {
      assert.deepStrictEqual(resp[0]?.data, JSON.stringify({ i }));
    });
  });

  test("calling an unknown tool rejects", TIMEOUT, async () => {
    await assert.rejects(manager.callTool('echo_nope', {}), /tool echo_nope not found/);
  });

  test("envelopes emitted by the child are forwarded to onEnvelopeBlock", TIMEOUT, async () => {
    await manager.callTool('echo_envelope', { text: 'hi there' });
    await waitFor(() => envelopes.length === 1);
    const [{ block, process }] = envelopes;
    assert.strictEqual(process.name, 'echo');
    assert.deepStrictEqual(block, {
      type: 'envelope',
      kind: 'message',
      from: 'test:echo',
      blocks: [{ type: 'data', mime: 'text/plain', data: 'hi there' }],
    });
  });

  test("pending tool calls reject when the child exits", TIMEOUT, async () => {
    await assert.rejects(manager.callTool('echo_crash', {}), /process exited/);
  });

  test("multiple blocks in a single stdout chunk are all delivered", TIMEOUT, async () => {
    await manager.callTool('echo_burst', {});
    await waitFor(() => envelopes.length === 1, 500);
    assert.deepStrictEqual(envelopes[0]?.block.blocks, [
      { type: 'data', mime: 'text/plain', data: 'burst' },
    ]);
  });

});
