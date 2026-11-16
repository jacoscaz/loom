
import { DataBlock, EnvelopeBlock, ToolDeclBlock } from "@loom/proto";
import { ToolClient, ToolServer } from "../types.js";
import { LocalToolServer } from "../local/server.js";
import { LocalToolClient } from "../local/client.js";
import { ProcessToolClient } from "../process/client.js";
import { wait } from "@loom/utils";

export class ToolServerManager {

  #tools: Map<string, { client: ToolClient, decl: ToolDeclBlock }> = new Map();
  #clients: Map<string, { client: ToolClient }> = new Map();

  constructor() {
    this.#tools = new Map();
    this.#clients = new Map();
  }

  #onEnvelope = async (block: EnvelopeBlock, process: ToolClient) => {

  };

  #registerServer = async (client: ToolClient) => {
    client.onEnvelope = this.#onEnvelope;
    this.#clients.set(client.name, { client });
    for (const tool of client.listTools()) {
      this.#registerTool(client, tool);
    }
  };

  #registerTool = (client: ToolClient, decl: ToolDeclBlock) => {
    const name = `${client.name}_${decl.name}`;
    this.#tools.set(name, { client, decl });
  }

  async addLocalServer(server: LocalToolServer) {
    const client = new LocalToolClient(server);
    await this.#registerServer(client);
  }

  async addProcessServer(name: string, file: string, args: string[]) {
    const client = new ProcessToolClient(name, file, args);
    client.start();
    await wait(1000);
    await this.#registerServer(client);
  }

  async stop(): Promise<void> {
    await Promise.all(Array.from(this.#clients.values()).map(p => p.client.stop()));
  }

  listTools(): ToolDeclBlock[] {
    return Array.from(this.#tools.entries())
      .map(([name, { decl }]) => ({ ...decl, name }));
  }

  async callTool(name: string, params: any, session: string): Promise<DataBlock[]> {
    if (!this.#tools.has(name)) {
      throw new Error(`tool ${name} not found`);
    }
    const { client, decl } = this.#tools.get(name)!;
    return client.callTool(decl.name, params, session);
  }

  onEnvelope = async (envelope: EnvelopeBlock, client: ToolClient) => {

  };

}
