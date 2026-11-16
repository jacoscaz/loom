/**
 * Minimal tool server process used by the process client tests. It is
 * spawned as a child process and talks to the parent over stdio.
 */
import { ProcessToolServer } from "../process/server.js";

const server = new ProcessToolServer('echo');

server.addTool<{ text: string }>('echo', 'Echoes the given text back', async ({ text }) => {
  return [{ type: 'data', mime: 'text/plain', data: text }];
});

server.addTool<{ ms: number }>('sleep', 'Resolves after the given delay', async ({ ms }) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return [{ type: 'data', mime: 'text/plain', data: `slept ${ms}` }];
});

server.addTool<{}>('fail', 'Always throws', async () => {
  throw new Error('boom');
});

server.addTool<{}>('exit', 'Terminates the process without responding', async () => {
  process.exit(1);
});
