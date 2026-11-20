import { is, ReceiveType, resolveReceiveType, toJsonSchema } from "@runtyped/type";
import { Block, EnvelopeBlock, ToolCallBlock, ToolDeclBlock, ToolRespBlock, DataBlock } from "@loom/proto";
import pinetto, { ProcessWriter, type Logger } from "pinetto";
import { encodeBlock, readBlocks } from "../framing/framing.js";
import { LocalToolServer } from "../local/server.js";
import { ToolHandler, ToolServer } from "../types.js";

let singleton: ProcessToolServer | undefined;

export class ProcessToolServer implements ToolServer {

  #server: LocalToolServer;

  logger: Logger;

  constructor(name: string) {
    if (singleton) {
      throw new Error('ProcessIO is a singleton');
    }
    singleton = this;
    this.#server = new LocalToolServer(name);
    readBlocks(process.stdin, this.#onStdinBlock);
    this.logger = pinetto({
      prefix: `process:${name}`,
      writer: new ProcessWriter('stderr'),
    });
  }

  get name(): string {
    return this.#server.name;
  }

  hasTool(name: string): boolean {
    return this.#server.hasTool(name);
  }

  addTool<T>(name: string, description: string, handler: ToolHandler<T>, __type_T?: ReceiveType<T>) {
    __type_T = resolveReceiveType(__type_T);
    this.#server.addTool<T>(name, description, handler, __type_T);
    // Announce the new tool so that the client can update its declarations.
    this.#sendBlock(this.#server.listTools().find(d => d.name === name)!);
  }

  listTools(): ToolDeclBlock[] {
    return this.#server.listTools();
  }

  callTool(name: string, params: any, session: string): DataBlock[] | Promise<DataBlock[]> {
    return this.#server.callTool(name, params, session);
  }

  #onStdinBlock = async (block: Block): Promise<void> => {
    switch (block.type) {
      case 'tool_call':
        return this.#onToolCallBlock(block);
      default:
        break;
    }
  };

  #onToolCallBlock = async (block: ToolCallBlock): Promise<void> => {
    const { tool, params, session } = block;
    const response: DataBlock[] = await Promise.resolve(this.callTool(tool, params, session)).catch((err) => {
      return [{
        type: 'data',
        mime: 'text/plain',
        data: `error: ${err}`,
      }];
    });
    this.#sendBlock({
      type: 'tool_resp',
      call_id: block.call_id,
      response,
      session,
    });
  };

  #sendBlock(block: EnvelopeBlock | ToolDeclBlock | ToolRespBlock) {
    process.stdout.write(encodeBlock(block));
  }

  sendEnvelope(envelope: EnvelopeBlock): Promise<void> {
    return Promise.resolve(this.#sendBlock(envelope));
  }



}
