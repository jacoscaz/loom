
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Block, DataBlock } from "../blocks/index.js";
import { ToolCallBlock, ToolDeclBlock, ToolRespBlock } from "../blocks/tools.js";
import { nonSafeRandom, Deferred } from "@loom/utils";
import { EnvelopeBlock } from "../blocks/envelopes.js";
import { encodeBlock, readBlocks } from "../framing.js";


export interface ProcessOpts {
  // absolute path to the program to run
  name: string;
  file: string;
  args: string[];
  onProcessExit: (code: number | null, signal: string | null, process: Process) => void;
  onToolDeclBlock: (block: ToolDeclBlock, process: Process) => Promise<void>;
  onEnvelopeBlock: (envelope: EnvelopeBlock, process: Process) => Promise<void>;
}

export class Process {

  #opts: ProcessOpts;
  #child?: ChildProcessWithoutNullStreams;
  #detachStdout?: () => void;
  #tool_calls: Map<string, { block: ToolCallBlock, deferred: Deferred<DataBlock[]> }>;
  #tool_decls: Map<string, ToolDeclBlock>;
  #stopped: boolean;
  #restart_timer?: NodeJS.Timeout;

  constructor(opts: ProcessOpts) {
    this.#opts = opts;
    this.#tool_calls = new Map();
    this.#tool_decls = new Map();
    this.#stopped = true;
  }

  get name(): string {
    return this.#opts.name;
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
    const { file, args } = this.#opts;
    this.#child = spawn(file, args, {
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
    this.#opts.onProcessExit(code, signal, this);
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
      case 'envelope':
        return this.#onEnvelopeBlock(block);
      default:
        console.log('processes should not send blocks of type', block.type);
    }
  };

  #onToolDeclBlock = async (block: ToolDeclBlock) => {
    this.#tool_decls.set(block.name, block);
    return this.#opts.onToolDeclBlock(block, this);
  };

  #onToolRespBlock = async (block: ToolRespBlock) => {
    const entry = this.#tool_calls.get(block.call_id);
    if (!entry) return;
    entry.deferred.resolve(block.response);
  };

  #onEnvelopeBlock = async (block: EnvelopeBlock) => {
    return this.#opts.onEnvelopeBlock(block, this);
  };

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



}
