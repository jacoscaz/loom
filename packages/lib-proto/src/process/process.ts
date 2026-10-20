import { is, ReceiveType, resolveReceiveType, toJsonSchema } from "@runtyped/type";
import { DataBlock } from "../blocks/data.js";
import { Block, EnvelopeBlock, ToolCallBlock, ToolDeclBlock, ToolRespBlock } from "../blocks/index.js";
import pinetto, { type Logger } from "pinetto";
import { encodeBlock, readBlocks } from "../framing.js";

let singleton: ProcessIO | undefined;

interface ProcessIOOpts {
  name: string;
}

export class ProcessIO {

  #opts: ProcessIOOpts;
  #tools: Map<string, { decl: ToolDeclBlock, handler: (params: any) => Promise<DataBlock[]> }>;

  logger: Logger;

  constructor(opts: ProcessIOOpts) {
    if (singleton) {
      throw new Error('ProcessIO is a singleton');
    }
    this.#opts = opts;
    singleton = this;
    this.#tools = new Map();
    readBlocks(process.stdin, this.#onStdinBlock);
    this.logger = pinetto({
      prefix: `process:${opts.name}`,
      writer: process.stderr,
    });
  }


  registerTool<T>(name: string, description: string, handler: (params: T) => Promise<DataBlock[]>, __type_T?: ReceiveType<T>) {
    __type_T = resolveReceiveType(__type_T);
    const params_schema = toJsonSchema<T>(__type_T);
    const __handler = async (params: unknown): Promise<DataBlock[]> => {
      if (is<T>(params, __type_T)) {
        return handler(params);
      }
      throw new Error('Invalid params');
    };
    const decl: ToolDeclBlock = { type: 'tool_decl', name, description, params_schema };
    this.#tools.set(name, { decl, handler: __handler });
    this.#sendBlock(decl);
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
    const { tool, params } = block;
    let response: DataBlock[];
    if (this.#tools.has(block.tool)) {
      const { handler } = this.#tools.get(block.tool)!;
      try {
        response = await handler(params);
      } catch (err) {
        response = [{
          type: 'data',
          mime: 'text/plain',
          data: `error: ${err}`,
        }];
      }
    } else {
      response = [{
        type: 'data',
        mime: 'text/plain',
        data: `tool not found`,
      }];
    }
    this.#sendBlock({
      type: 'tool_resp',
      call_id: block.call_id,
      response,
    });
  };

  #sendBlock(block: EnvelopeBlock | ToolDeclBlock | ToolRespBlock) {
    process.stdout.write(encodeBlock(block));
  }

  sendEnvelope(envelope: EnvelopeBlock) {

  }



}
