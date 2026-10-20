
import { DataBlock } from "../blocks/data.js";
import { EnvelopeBlock } from "../blocks/envelopes.js";
import { ToolDeclBlock } from "../blocks/tools.js";
import { Process } from "./process.js";

export interface ProcessManagerOpts {
  onEnvelopeBlock: (block: EnvelopeBlock, process: Process) => Promise<void>;
}

export class ProcessManager {

  #opts: ProcessManagerOpts;
  #tools: Map<string, { process: Process, decl: ToolDeclBlock }> = new Map();
  #processes: Map<string, Process> = new Map();

  constructor(opts: ProcessManagerOpts) {
    this.#opts = opts;
  }

  #onProcessExit = (code: number | null, signal: string | null, process: Process) => {

  };

  #onToolDeclBlock = async (block: ToolDeclBlock, process: Process) => {
    const name = `${process.name}_${block.name}`;
    // Re-declarations from the same process (e.g. after a restart) replace
    // the previous declaration.
    const existing = this.#tools.get(name);
    if (existing && existing.process !== process) {
      throw new Error(`tool ${name} already exists`);
    }
    this.#tools.set(name, { process, decl: block });
  };

  #onEnvelopeBlock = async (block: EnvelopeBlock, process: Process) => {
    return this.#opts.onEnvelopeBlock(block, process);
  };

  start(name: string, file: string, args: string[]) {
    if (this.#processes.has(name)) {
      throw new Error(`process ${name} already exists`);
    }
    const process = new Process({
      name,
      file,
      args,
      onProcessExit: this.#onProcessExit,
      onToolDeclBlock: this.#onToolDeclBlock,
      onEnvelopeBlock: this.#onEnvelopeBlock,
    });
    this.#processes.set(name, process);
    process.start();
  }

  async stop(): Promise<void> {
    await Promise.all(Array.from(this.#processes.values()).map(p => p.stop()));
  }

  listTools(): ToolDeclBlock[] {
    return Array.from(this.#tools.entries())
      .map(([name, { decl }]) => ({ ...decl, name }));
  }

  async callTool(name: string, params: any): Promise<DataBlock[]> {
    if (!this.#tools.has(name)) {
      throw new Error(`tool ${name} not found`);
    }
    const { process, decl } = this.#tools.get(name)!;
    if (!process.running) {
      throw new Error(`process ${process.name} is not running`);
    }
    return process.callTool(decl.name, params);
  }

}
