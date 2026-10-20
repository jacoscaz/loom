import { is, ReceiveType, resolveReceiveType, toJsonSchema } from "@runtyped/type";
import { DataBlock } from "../blocks/data.js";
import { Block, EnvelopeBlock, ToolCallBlock, ToolDeclBlock, ToolRespBlock } from "../blocks/index.js";
import pinetto, { type Logger } from "pinetto";

let singleton: ProcessIO | undefined;

interface ProcessIOOpts {
  name: string;
}

export class ProcessIO {

  #opts: ProcessIOOpts;
  #stdin: string[];
  #tools: Map<string, { decl: ToolDeclBlock, handler: (params: any) => Promise<DataBlock[]> }>;

  logger: Logger;

  constructor(opts: ProcessIOOpts) {
    if (singleton) {
      throw new Error('ProcessIO is a singleton');
    }
    this.#opts = opts;
    singleton = this;
    this.#stdin = [];
    this.#tools = new Map();
    process.stdin.on('data', this.#onStdinData);
    this.logger = pinetto({
      prefix: `process:${opts.name}`,
      writer: process.stderr,
    });
  }

  #onStdinData = (data: Buffer) => {
    const str = data.toString();
    const idx = str.indexOf('\n');
    if (idx !== -1) {
      const raw = this.#stdin.join('') + str.slice(0, idx);
      try {
        const maybe_block = JSON.parse(raw);
        if (is<Block>(maybe_block)) {
          process.stdin.pause();
          this.#onStdinBlock(maybe_block).catch(() => { }).finally(() => {
            process.stdin.resume();
          });
        } else {
          // TODO: discard block
        }
      } catch (err) {
        // TODO: discard block
      }
      this.#stdin = [str.slice(idx + 1)];
    } else {
      if (this.#stdin.length > 1000) {
        this.#stdin.shift();
      }
      this.#stdin.push(str);
    }
  };

  registerTool<T>(name: string, description: string, handler: (params: T) => Promise<DataBlock[]>, __type_T?: ReceiveType<T>) {
    __type_T = resolveReceiveType(__type_T);
    const params_schema = toJsonSchema<T>(__type_T);
    const __handler = async (params: unknown): Promise<DataBlock[]> => {
      if (is<T>(params, __type_T)) {
        return handler(params);
      }
      throw new Error('Invalid params');
    };
    this.#tools.set(name, { decl: { type: 'tool_decl', name, description, params_schema }, handler: __handler });
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

  #sendBlock(block: EnvelopeBlock | ToolRespBlock) {
    process.stdout.write(JSON.stringify(block) + '\n');
  }

  sendEnvelope(envelope: EnvelopeBlock) {

  }



}
