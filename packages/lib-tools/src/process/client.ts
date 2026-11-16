
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { ToolCallBlock, ToolDeclBlock, ToolRespBlock, EnvelopeBlock, DataBlock, Block, ToolListBlock } from "@loom/proto";
import { nonSafeRandom, Deferred } from "@loom/utils";
import { encodeBlock, readBlocks } from "../framing/framing.js";
import { ToolClient } from "../types.js";


// export interface ProcessToolServerOpts extends ToolServerOpts<ProcessToolServer> {
  // absolute path to the program to run
  // name: string;
  // file: string;
  // args: string[];
  // onProcessExit: (code: number | null, signal: string | null, server: ProcessToolServer) => void;
  // onToolDecl: (block: ToolDeclBlock, server: ProcessToolServer) => void | Promise<void>;
  // onEnvelope: (envelope: EnvelopeBlock, server: ProcessToolServer) => void | Promise<void>;
// }

export class ProcessToolClient implements ToolClient {

  #name: string;
  #file: string;
  #args: string[];

  #child?: ChildProcessWithoutNullStreams;
  #detachStdout?: () => void;
  #tool_calls: Map<string, { block: ToolCallBlock, deferred: Deferred<DataBlock[]> }>;
  #tool_decls: Map<string, ToolDeclBlock>;
  #stopped: boolean;
  #restart_timer?: NodeJS.Timeout;

  constructor(name: string, file: string, args: string[]) {
    this.#name = name;
    this.#file = file;
    this.#args = args;

    this.#tool_calls = new Map();
    this.#tool_decls = new Map();
    this.#stopped = true;
  }

  get name(): string {
    return this.#name;
  }

  get running(): boolean {
    if (!this.#child) {
      return false;
    }
    if (this.#child.exitCode !== null) {
      return false;
    }
    if (this.#child.signalCode !== null) {
      return false;
    }
    return true;
  }

  #start = () => {
    if (this.running) {
      return;
    }
    this.#child = spawn(this.#file, this.#args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.on('exit', this.#onExit);
    this.#detachStdout = readBlocks(this.#child.stdout, this.#onStdoutBlock);
    this.#child.stderr.on('data', this.#onStderrData);
  };

  #onExit = (code: number | null, signal: string | null) => {
    this.#child?.removeListener('exit', this.#onExit);
    this.#detachStdout?.();
    this.#detachStdout = undefined;
    this.#child?.stderr.removeListener('data', this.#onStderrData);
    this.#child = undefined;
    const tool_calls = Array.from(this.#tool_calls.values());
    this.#tool_calls.clear();
    tool_calls.forEach(({ block, deferred }) => {
      deferred.reject(new Error('process exited'));
    });
    if (!this.#stopped) {
      this.#restart_timer = setTimeout(this.#start, 5_000);
    }
  };

  start() {
    this.#stopped = false;
    this.#start();
  }

  /**
   * Kills the child process (if running) and disables automatic restarts.
   * Resolves once the child has exited.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#restart_timer);
    const child = this.#child;
    if (!child || !this.running) {
      return;
    }
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill();
    });
  }


  #onStderrData = (data: Buffer) => {
    process.stderr.write(data);
  };

  /**
   * Must be overridden by subclasses.
   */
  #onStdoutBlock = async (block: Block) => {
    switch (block.type) {
      case 'tool_resp':
        return this.#onToolRespBlock(block);
      case 'tool_decl':
        return this.#onToolDeclBlock(block);
      case 'tool_list':
        return this.#onToolListBlock(block);
      case 'envelope':
        return this.#onEnvelopeBlock(block);
      default:
        console.log('processes should not send blocks of type', block.type);
    }
  };

  #onToolDeclBlock = async (block: ToolDeclBlock) => {
    this.#tool_decls.set(block.name, block);
  };

  #onToolListBlock = async (block: ToolListBlock) => {
    this.#tool_decls.clear();
    for (const decl of block.tools) {
      this.#tool_decls.set(decl.name, decl);
    }
  };

  #onToolRespBlock = async (block: ToolRespBlock) => {
    const entry = this.#tool_calls.get(block.call_id);
    if (!entry) return;
    entry.deferred.resolve(block.response);
  };

  #onEnvelopeBlock = async (block: EnvelopeBlock) => {
    return this.onEnvelope(block, this);
  };

  hasTool(name: string): boolean {
    return this.#tool_decls.has(name);
  }

  listTools(): ToolDeclBlock[] {
    return Array.from(this.#tool_decls.values());
  }

  async callTool(tool: string, params: any): Promise<DataBlock[]> {
    if (!this.#child || !this.running) {
      throw new Error('Process is not running');
    }
    const call_id = nonSafeRandom(8);
    const block: ToolCallBlock = {
      type: 'tool_call',
      call_id,
      tool,
      params,
    };
    const deferred = new Deferred<DataBlock[]>();
    // The derived promise must be handled, otherwise rejections surface as
    // unhandled even when the caller awaits `deferred.promise`.
    deferred.promise.finally(() => {
      this.#tool_calls.delete(call_id);
    }).catch(() => { });
    this.#tool_calls.set(call_id, { block, deferred });
    this.#child.stdin.write(encodeBlock(block));
    return deferred.promise;
  };

  onEnvelope = async (block: EnvelopeBlock, client: ToolClient) => {

  };

}
