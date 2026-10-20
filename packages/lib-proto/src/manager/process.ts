
import { is } from "@runtyped/type";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Block, DataBlock } from "../blocks/index.js";
import { ToolCallBlock, ToolDeclBlock, ToolRespBlock } from "../blocks/tools.js";
import { nonSafeRandom, Deferred } from "@loom/utils";
import { EnvelopeBlock } from "../blocks/envelopes.js";


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
  #stdout: string[];
  #stderr: string[];
  #tool_calls: Map<string, { block: ToolCallBlock, deferred: Deferred<DataBlock[]> }>;
  #tool_decls: Map<string, ToolDeclBlock>;

  constructor(opts: ProcessOpts) {
    this.#opts = opts;
    this.#stdout = [];
    this.#stderr = [];
    this.#tool_calls = new Map();
    this.#tool_decls = new Map();
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
    this.#child.stdout.on('data', this.#onStdoutData);
    this.#child.stderr.on('data', this.#onStderrData);
  };

  #onExit = (code: number | null, signal: string | null) => {
    this.#child?.removeListener('exit', this.#onExit);
    this.#child?.stdout.removeListener('data', this.#onStdoutData);
    this.#child?.stderr.removeListener('data', this.#onStderrData);
    this.#child = undefined;
    const tool_calls = Array.from(this.#tool_calls.values());
    this.#tool_calls.clear();
    tool_calls.forEach(({ block, deferred }) => {
      deferred.reject(new Error('process exited'));
    });
    this.#opts.onProcessExit(code, signal, this);
    setTimeout(this.#start, 5_000);
  };

  #onStdoutData = (data: Buffer) => {
    const str = data.toString();
    const idx = str.indexOf('\n');
    if (idx !== -1) {
      const raw = this.#stdout.join('') + str.slice(0, idx);
      try {
        const maybe_block = JSON.parse(raw);
        if (is<Block>(maybe_block)) {
          this.#child?.stdout.pause();
          this.#onStdoutBlock(maybe_block).catch(() => { }).finally(() => {
            this.#child?.stdout.resume();
          });
        } else {
          // TODO: discard block
        }
      } catch (err) {
        // TODO: discard block
      }
      this.#stdout = [str.slice(idx + 1)];
    } else {
      if (this.#stdout.length > 1000) {
        this.#stdout.shift();
      }
      this.#stdout.push(str);
    }
  };

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
    this.#opts.onToolDeclBlock(block, this);
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
    deferred.promise.finally(() => {
      this.#tool_calls.delete(call_id);
    });
    this.#tool_calls.set(call_id, { block, deferred });
    this.#child.stdin.write(JSON.stringify(block) + '\n');
    return deferred.promise;
  };



}
