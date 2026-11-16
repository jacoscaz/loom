
import { DataBlock, EnvelopeBlock, ToolDeclBlock } from "@loom/proto";
import { is, ReceiveType, resolveReceiveType, toJsonSchema } from "@runtyped/type";
import { ToolClient, ToolHandler, ToolServer } from "../types.js";

interface ToolEntry<P> {
  decl: ToolDeclBlock;
  handler: ToolHandler<P>;
}

const wrapHandler = <P>(handler: ToolHandler<P>, params_type?: ReceiveType<P>): ToolHandler<P> => {
  params_type = resolveReceiveType(params_type);
  return async (params: any) => {
    if (is<P>(params, params_type)) {
      return handler(params);
    }
    return [{ type: 'data', mime: 'text/plain', data: `Invalid params: ${JSON.stringify(params)}` }];
  };
};

/**
 * Allows both registration and invocation of tools.
 * Implements both the `ToolRegistry` and `ToolServer` interfaces.
 */
export class LocalToolServer implements ToolServer {

  #name: string;
  #tools: Map<string, ToolEntry<any>>;

  constructor(name: string) {
    this.#name = name;
    this.#tools = new Map();
  }

  get name(): string {
    return this.#name;
  }

  stop(): void | Promise<void> {
    return;
  }

  hasTool(name: string): boolean {
    return this.#tools.has(name);
  }

  addTool<P>(name: string, description: string, handler: ToolHandler<P>, params_type?: ReceiveType<P>) {
    params_type = resolveReceiveType(params_type);
    const params_schema = toJsonSchema<P>(params_type);
    const entry: ToolEntry<P> = {
      decl: {
        type: 'tool_decl',
        name,
        description,
        params_schema,
      },
      handler: wrapHandler(handler, params_type),
    };
    this.#tools.set(name, entry);
  }

  async callTool(name: string, params: any): Promise<DataBlock[]> {
    let response: DataBlock[];
    if (this.#tools.has(name)) {
      const { handler } = this.#tools.get(name)!;
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
    return response;
  }

  listTools(): ToolDeclBlock[] {
    return Array.from(this.#tools.values()).map(v => ({ ...v.decl }));
  }

  /**
   *
   * @internal
   */
  __onEnvelope = async (envelope: EnvelopeBlock) => {

  };

  sendEnvelope(envelope: EnvelopeBlock): void | Promise<void> {
    return this.__onEnvelope(envelope);
  }

}
