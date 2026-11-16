import { DataBlock, EnvelopeBlock, ToolDeclBlock } from "@loom/proto";

export type ToolHandler<T> = (params: T) => DataBlock[] | Promise<DataBlock[]>;

/**
 * Used by tool consumers to make tool calls.
 */
export interface ToolServer {
  name: string;
  addTool<P>(name: string, description: string, handler: ToolHandler<P>): void | Promise<void>;
  hasTool(name: string): boolean | Promise<boolean>;
  callTool(name: string, params: any): DataBlock[] | Promise<DataBlock[]>;
  listTools(): ToolDeclBlock[] | Promise<ToolDeclBlock[]>;
  sendEnvelope(envelope: EnvelopeBlock): void | Promise<void>;
  // onEnvelope(envelope: EnvelopeBlock, server: ToolServer): void | Promise<void>;
}

export interface ToolClient {
  name: string;
  stop(): void | Promise<void>;
  hasTool(name: string): boolean;
  callTool(name: string, params: any): Promise<DataBlock[]>;
  listTools(): ToolDeclBlock[];
  onEnvelope(envelope: EnvelopeBlock, client: ToolClient): void | Promise<void>;
}
