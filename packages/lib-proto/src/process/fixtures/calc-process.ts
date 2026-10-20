/**
 * Test fixture: a tool-providing child process built on ProcessIO.
 */

import { ProcessIO } from "../process.js";

interface AddParams {
  a: number;
  b: number;
}

interface UpperParams {
  text: string;
}

const io = new ProcessIO({ name: 'calc' });

io.registerTool<AddParams>('add', 'Adds two numbers', async ({ a, b }) => {
  return [{ type: 'data', mime: 'text/plain', data: String(a + b) }];
});

io.registerTool<UpperParams>('upper', 'Uppercases text', async ({ text }) => {
  return [{ type: 'data', mime: 'text/plain', data: text.toUpperCase() }];
});

io.registerTool<{}>('fail', 'Always throws', async () => {
  throw new Error('boom');
});
