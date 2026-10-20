import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
  /** The body parsed as JSON, when it is JSON. */
  json?: any;
}

export type FakeHandler = (req: RecordedRequest, res: ServerResponse) => void;

export interface FakeServer {
  /** e.g. http://127.0.0.1:12345 */
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/**
 * A local HTTP server standing in for a provider API. Handlers are keyed
 * by `${method} ${path}`; every request is recorded for assertions.
 */
export const fakeServer = async (handlers: Record<string, FakeHandler>): Promise<FakeServer> => {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    let json: any;
    try { json = JSON.parse(body.toString()); } catch { /* not JSON */ }
    const recorded: RecordedRequest = { method: req.method!, url: req.url!, headers: req.headers, body, json };
    requests.push(recorded);
    const handler = handlers[`${req.method} ${req.url!.split('?')[0]}`];
    if (!handler) {
      res.writeHead(404).end(`no handler for ${req.method} ${req.url}`);
      return;
    }
    handler(recorded, res);
  });
  // Bind failures (e.g. EPERM in sandboxed environments) must fail the
  // suite loudly instead of hanging it.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
};

export interface SSEEvent {
  event?: string;
  data: unknown;
}

/** Writes a server-sent events response. Strings are sent verbatim as `data:` lines (e.g. '[DONE]'). */
export const sendSSE = (res: ServerResponse, events: (SSEEvent | string)[]) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const e of events) {
    if (typeof e === 'string') {
      res.write(`data: ${e}\n\n`);
    } else {
      res.write(`${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`);
    }
  }
  res.end();
};

export const sendJSON = (res: ServerResponse, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
