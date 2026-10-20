/**
 * Test fixture: a minimal tool-providing child process that speaks the
 * newline-delimited JSON protocol by hand (deliberately not using ProcessIO,
 * so that manager-side tests don't depend on the child-side implementation).
 *
 * Tools:
 * - echo:     responds with a text block containing JSON.stringify(params)
 * - envelope: emits a message envelope, then responds
 * - burst:    emits an envelope and the response in a single stdout write
 * - crash:    exits without responding
 */

import { createInterface } from "node:readline";
import type { Block, ToolCallBlock, ToolDeclBlock } from "../../blocks/index.js";


const send = (block: Block) => {
  process.stdout.write(JSON.stringify(block) + '\n');
};

const decl = (name: string, description: string): ToolDeclBlock => ({
  type: 'tool_decl',
  name,
  description,
  params_schema: { type: 'object' },
});

const handleCall = async (call: ToolCallBlock) => {
  switch (call.tool) {
    case 'echo':
      send({
        type: 'tool_resp',
        call_id: call.call_id,
        response: [{ type: 'data', mime: 'text/plain', data: JSON.stringify(call.params) }],
      });
      break;
    case 'envelope':
      send({
        type: 'envelope',
        kind: 'message',
        from: 'test:echo',
        blocks: [{ type: 'data', mime: 'text/plain', data: String(call.params.text) }],
      });
      send({ type: 'tool_resp', call_id: call.call_id, response: [] });
      break;
    case 'burst':
      process.stdout.write(
        JSON.stringify({
          type: 'envelope',
          kind: 'message',
          from: 'test:echo',
          blocks: [{ type: 'data', mime: 'text/plain', data: 'burst' }],
        }) + '\n' +
        JSON.stringify({ type: 'tool_resp', call_id: call.call_id, response: [] }) + '\n',
      );
      break;
    case 'crash':
      process.exit(1);
  }
};

createInterface({ input: process.stdin }).on('line', (line) => {
  const block = JSON.parse(line) as Block;
  if (block.type === 'tool_call') {
    handleCall(block).catch((err) => {
      process.stderr.write(`echo-process: ${err}\n`);
    });
  }
});

for (const block of [
  decl('echo', 'Echoes params back as text'),
  decl('envelope', 'Emits a message envelope'),
  decl('burst', 'Emits an envelope and a response in a single write'),
  decl('crash', 'Exits without responding'),
]) {
  send(block);
}
