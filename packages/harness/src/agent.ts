
import type {
  Block,
  DataBlock,
  EnvelopeBlock,
  Message,
  ToolCallBlock,
  ToolDeclBlock,
  ToolRespBlock,
} from "@loom/proto";
import type { CompletionQueryOpts, CompletionQueryResult } from "@loom/models";
import { renderSystemPrompt } from "./prompt.js";
import type { ActivationOutput } from "./database/tables/messages.js";
import type { HistoryStore } from "./stores/store.js";

/** The slice of a @loom/models completion model the agent needs. */
export interface AgentModel {
  query(opts: CompletionQueryOpts): Promise<CompletionQueryResult>;
}

/** The slice of the @loom/tools ToolServerManager the agent needs. */
export interface AgentTools {
  listTools(): ToolDeclBlock[];
  callTool(name: string, params: any, session: string): Promise<DataBlock[]>;
}

export interface AgentLogger {
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

export interface AgentOpts {
  model: AgentModel;
  tools: AgentTools;
  store: HistoryStore;
  system_prompt: string;
  /** Maximum number of model queries per turn. Defaults to 16. */
  max_steps_per_turn?: number;
  logger?: AgentLogger;
}

interface Runner {
  running?: Promise<void>;
  /** Set when work arrives while a turn is in progress. */
  dirty: boolean;
}

const errMessage = (err: unknown): string => err instanceof Error ? err.message : String(err);

const isToolCall = (block: Block): block is ToolCallBlock => block.type === 'tool_call';

const NOOP_LOGGER: AgentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Minimal agent loop.
 *
 * Every envelope is durably stored, as an unprocessed message, in the
 * session it names. Each session then runs at most one turn at a time: a
 * sequence of activations, each feeding the whole history to the model
 * and executing the tool calls it makes. Tool responses are stored as
 * unprocessed, which triggers the next activation; the turn ends when the
 * model stops calling tools (or the step limit is hit). Envelopes that
 * arrive mid-turn are picked up by the next activation.
 */
export class Agent {

  #model: AgentModel;
  #tools: AgentTools;
  #store: HistoryStore;
  #system_prompt: string;
  #max_steps: number;
  #log: AgentLogger;
  #runners: Map<string, Runner> = new Map();

  constructor(opts: AgentOpts) {
    this.#model = opts.model;
    this.#tools = opts.tools;
    this.#store = opts.store;
    this.#system_prompt = opts.system_prompt;
    this.#max_steps = opts.max_steps_per_turn ?? 16;
    this.#log = opts.logger ?? NOOP_LOGGER;
  }

  /**
   * Accepts an envelope for processing. Resolves once the envelope has been
   * durably stored; the turn it triggers runs in the background.
   */
  async receive(envelope: EnvelopeBlock): Promise<void> {
    await this.#store.appendIncoming(envelope.session, [envelope]);
    this.#kick(envelope.session);
  }

  /**
   * Starts a turn for every session with unprocessed messages, e.g.
   * envelopes stored right before a crash. Call once at boot.
   */
  async resume(): Promise<string[]> {
    const sessions = await this.#store.pendingSessions();
    sessions.forEach(session => this.#kick(session));
    return sessions;
  }

  /** The conversation history of a session. */
  history(session: string): Promise<Message[]> {
    return this.#store.history(session);
  }

  /** Resolves once no session has a turn in progress. */
  async idle(): Promise<void> {
    while (true) {
      const running = Array.from(this.#runners.values())
        .map(r => r.running)
        .filter((p): p is Promise<void> => !!p);
      if (running.length === 0) {
        return;
      }
      await Promise.all(running);
    }
  }

  #kick(session: string) {
    let runner = this.#runners.get(session);
    if (!runner) {
      runner = { dirty: false };
      this.#runners.set(session, runner);
    }
    if (runner.running) {
      runner.dirty = true;
      return;
    }
    runner.dirty = false;
    const r = runner;
    // `running` must be set before #run() starts executing: a synchronous
    // #kick() from within the turn would otherwise start a second one.
    r.running = Promise.resolve().then(() => this.#run(session)).finally(() => {
      r.running = undefined;
      if (r.dirty) {
        this.#kick(session);
      }
    });
  }

  async #run(session: string): Promise<void> {
    const system_prompt = renderSystemPrompt(this.#system_prompt, session);
    for (let step = 1; step <= this.#max_steps; step += 1) {
      let more: boolean;
      try {
        more = await this.#store.activate(session, (history) => this.#activate(session, system_prompt, history));
      } catch (err) {
        // Unprocessed messages stay unprocessed: the next envelope (or the
        // next boot) retries.
        this.#log.error('session %s: activation failed: %s', session, errMessage(err));
        return;
      }
      if (!more) {
        return;
      }
    }
    this.#log.warn('session %s: turn stopped after %d steps', session, this.#max_steps);
  }

  async #activate(session: string, system_prompt: string, history: Message[]): Promise<ActivationOutput[]> {
    const result = await this.#model.query({
      tools: this.#tools.listTools(),
      messages: history,
      system_prompt,
      session_id: session,
    });
    const output: ActivationOutput[] = result.messages.map(message => ({ message, processed: true }));
    const calls = result.messages.flatMap(m => m.blocks).filter(isToolCall);
    if (calls.length > 0) {
      // Every tool call must be answered, otherwise providers reject the
      // history on the next query.
      const responses: Block[] = [];
      for (const call of calls) {
        responses.push(await this.#callTool(session, call));
      }
      output.push({ message: { role: 'user', blocks: responses }, processed: false });
    }
    return output;
  }

  async #callTool(session: string, call: ToolCallBlock): Promise<ToolRespBlock> {
    let response: DataBlock[];
    try {
      response = await this.#tools.callTool(call.tool, call.params, session);
    } catch (err) {
      response = [{ type: 'data', mime: 'text/plain', data: `error: ${errMessage(err)}` }];
    }
    this.#log.info('session %s: %s(%s)', session, call.tool, JSON.stringify(call.params));
    return { type: 'tool_resp', call_id: call.call_id, response, session };
  }

}
