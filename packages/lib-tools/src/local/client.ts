
import { DataBlock, EnvelopeBlock, ToolDeclBlock } from "@loom/proto";
import { LocalToolServer } from "./server.js";
import { ToolClient } from "../types.js";

/**
 * Pass-through class to expose a LocalToolServer instance as a ToolClient
 * implementation.
 */
export class LocalToolClient implements ToolClient {

  #server: LocalToolServer;

  constructor(server: LocalToolServer) {
    this.#server = server;
    server.__onEnvelope = (block: EnvelopeBlock) => {
      return this.onEnvelope(block, this);
    };
  }

  get name() {
    return this.#server.name;
  }

  stop(): void | Promise<void> {
    return this.#server.stop();
  }

  hasTool(name: string): boolean {
    return this.#server.hasTool(name);
  }

  listTools(): ToolDeclBlock[] {
    return this.#server.listTools();
  }

  async callTool(name: string, params: any, session: string): Promise<DataBlock[]> {
    return this.#server.callTool(name, params, session);
  }

  onEnvelope = async (envelope: EnvelopeBlock, client: LocalToolClient) => {

  };



}
