import { ellipsis, errToString } from "@loom/utils";
import { type DB } from "../database/client.js";
import { selectSessionById, updateSessionTokens } from "../database/tables/sessions.js";
import { type ASelectableDBMessage, selectMessagesForActivation, type AInsertableDBMessage, insertMessage, selectMessages } from "../database/tables/messages.js";
import { type TextBlock } from "../types/blocks.js";
import { AgentMessage, AgentToolRequest, UserBlock, UserToolResult, type Message, type UserMessage, type ToolRequestBlock } from "../types/messages.js";
import { type InitContext, WithContext } from "../context.js";
import { type Logger } from 'pinetto';
import { ToolCallContext } from "../types/tools.js";
import { type AbstractSessionModel } from "../models/session/abstract.js";
import { getMonotonicDate } from "../monotonic.js";
import { detectInjections } from "./injection-guardrails.js";
import { makeActivationPrompt } from "../prompts/activation.js";

import { ToolManager } from "../tools/manager.js";
import { EVENT_PREFIX } from "../constants.js";


export interface SessionRunnerEvents extends Record<string, any[]> {
  message: [message: Message];
  idle: [prompt_size?: number];
}

export class SessionRunner extends WithContext<SessionRunnerEvents> {

  #model: AbstractSessionModel;
  #logger: Logger;
  #running: boolean;
  #injected: AInsertableDBMessage[] = [];
  #prompt_size?: number;
  #origin_session_id: number;
  #target_session_id: number;
  #pre_query_listeners: (() => Promise<void>)[] = [];
  #post_query_listeners: (() => Promise<void>)[] = [];
  #heartbeat_timer: NodeJS.Timeout | null = null;
  /** Whether this runner mirrors the session stream to the monologue log. */
  #monologue_enabled: boolean;
  #last_heartbeat_activation_at?: Date;
  /** Last REAL activation — a run whose loop actually processed messages.
   *  Empty heartbeat drains do NOT update this (see run()'s finally): they
   *  would re-arm the quiet period every tick and permanently suppress
   *  synthetic activations (bug found 2026-09-18: zero heartbeat
   *  activations since the quiet period landed on 2026-08-30). */
  #last_activation_at?: Date;
  /** Whether the current run() loop processed at least one message batch. */
  #loop_did_work = false;
  /** Maximum activations (query loop iterations) per run() invocation.
   *  Set per-run by the caller; every caller must pass a limit. */
  #max_queries_per_run!: number;
  #query_count = 0;
  /** Default activation limit, used by internal run() re-invocations
   *  (heartbeat ticks, deferred runs). The main session's generous cap;
   *  ephemeral runners pass their own tighter limit explicitly. */
  static DEFAULT_MAX_QUERIES_PER_RUN = 200;

  constructor(ctx: InitContext, origin_session_id: number, target_session_id: number, model: AbstractSessionModel) {
    super(ctx);
    this.#model = model;
    this.#logger = ctx.logger.child(`[session:${origin_session_id}]`);
    this.#running = false;
    this.#injected = [];
    this.#origin_session_id = origin_session_id;
    this.#target_session_id = target_session_id;
    // Only the main session mirrors its stream to the monologue log:
    // transient runners (distiller, compactor) write their exchanges
    // to the ops log, not to the human-facing transcript — same policy
    // as the heartbeat. Enabled explicitly via enableMonologue() by
    // the SessionManager for the main session only.
    this.#monologue_enabled = false;
    this.#pre_query_listeners = [];
    this.#post_query_listeners = [];
  }

  // ── Dynamic substrate switching (2026-09-03) ──
  // The runner owns its session's active model: switching is per-session
  // state with the runner's lifecycle. Restarts reset to the FIRST config
  // entry (the one place ordering matters — Jacopo's review, PR #27:
  // identity is by id everywhere else; 'default' is not a concept).

  /** The currently active model instance (`.id` for its identifier). */
  getModel(): AbstractSessionModel {
    return this.#model;
  }

  /**
   * Switch this session's model to the adapter with the given config id.
   * The adapter instance implicitly determines the id — no separate
   * model-id state (Jacopo's review round 2: one source of truth).
   * Returns the id of the now-active model.
   */
  switchModel(id: string): string {
    const model = this._ctx.managers.models.session(id);
    if (model === this.#model) return this.#model.id;
    const previous = this.#model.id;
    this.#model = model;
    this.#logger.info('model switched: %s -> %s', previous, model.id);
    return model.id;
  }

  /**
   * Request a reasoning-effort change on the active model. Adapters that
   * don't support effort (or have it disabled) no-op with `false` — this
   * never errors (Jacopo's ruling, 2026-09-03).
   */
  setReasoningEffort(effort: string): boolean {
    const applied = this.#model.setReasoningEffort(effort);
    this.#logger.info('reasoning effort request \'%s\': %s', effort, applied ? 'applied' : 'not supported by active model, ignored');
    return applied;
  }

  /**
   * Start the internal heartbeat. Only called for the main session
   * runner; transient runners (distiller) have no heartbeat.
   */
  startHeartbeat(): void {
    if (this.#heartbeat_timer) return;
    const interval_ms = this._ctx.config.heartbeat?.interval ?? 30_000;
    this.#heartbeat_timer = setInterval(() => this.#onHeartbeatTick(), interval_ms);
    const activation_ms = this._ctx.config.heartbeat?.activation_interval_ms ?? 0;
    this.#logger.info('heartbeat every %dms (activation interval: %dms)', interval_ms, activation_ms);
  }

  stopHeartbeat(): void {
    if (this.#heartbeat_timer) {
      clearInterval(this.#heartbeat_timer);
      this.#heartbeat_timer = null;
    }
  }

  /** Enable mirroring of this session's stream to the monologue log. */
  enableMonologue(): void {
    this.#monologue_enabled = true;
  }

  /**
   * Heartbeat tick: drain pending messages. If the minimum activation
   * interval has elapsed since the last heartbeat-driven activation,
   * inject the honest activation message first — the injection itself
   * is the work that run() then processes.
   */
  #onHeartbeatTick(): void {
    if (this.#running) {
      this.#logger.debug('heartbeat tick skipped: already running');
      return;
    }
    const activation_interval_ms = this._ctx.config.heartbeat?.activation_interval_ms ?? 0;
    if (activation_interval_ms > 0) {
      const now = new Date();

      // Quiet period: suppress heartbeat-driven activation for a configurable
      // time after ANY activation. Pending messages are still drained by the
      // run() below — only the synthetic activation prompt is deferred. This
      // keeps heartbeats from fragmenting ongoing exchanges with slow-typing
      // humans (or slow-working agents).
      const quiet_after_ms = this._ctx.config.heartbeat?.quiet_after_ms ?? 0;
      const last_any = this.#last_activation_at;
      if (quiet_after_ms > 0 && last_any && (now.valueOf() - last_any.valueOf()) < quiet_after_ms) {
        const elapsed = Math.round((now.valueOf() - last_any.valueOf()) / 60_000);
        this.#logger.debug('heartbeat tick skipped: quiet period (last activation %dm ago)', elapsed);
        this.run(undefined, undefined, SessionRunner.DEFAULT_MAX_QUERIES_PER_RUN);
        return;
      }

      const last = this.#last_heartbeat_activation_at;
      if (!last || (now.valueOf() - last.valueOf()) >= activation_interval_ms) {
        const elapsed = last ? Math.round((now.valueOf() - last.valueOf()) / 60_000) : null;
        this.#last_heartbeat_activation_at = now;
        this.#logger.info('heartbeat activation triggered (last activation %s)', elapsed !== null ? `${elapsed}m ago` : 'at boot');
        this.injectEventMessage('heartbeat', makeActivationPrompt(), false).catch(err => {
          this.#logger.error('heartbeat activation injection error: %s', errToString(err));
        });
      }
    }
    this.run(undefined, undefined, SessionRunner.DEFAULT_MAX_QUERIES_PER_RUN);
  }

  /** Whether the runner is currently processing an activation loop. */
  get running(): boolean {
    return this.#running;
  }

  /** Timestamp of the moment the runner last became idle (undefined if never ran). */
  #last_idle_at?: Date;

  get lastIdleAt(): Date | undefined {
    return this.#last_idle_at;
  }

  /** Timestamp of the last REAL activation (messages actually processed),
   *  or undefined if none since process start. The emygdala reads this for
   *  time-passage salience; the heartbeat quiet period re-arms on it. */
  get lastActivationAt(): Date | undefined {
    return this.#last_activation_at;
  }

  addPreQueryListener(listener: () => Promise<void>) {
    this.#pre_query_listeners.push(listener);
  }

  async #runPreQueryListeners(db: DB) {
    for (const listener of this.#pre_query_listeners) {
      await listener();
    }
  }

  addPostQueryListener(listener: () => Promise<void>) {
    this.#post_query_listeners.push(listener);
  }

  async #runPostQueryListeners(db: DB) {
    for (const listener of this.#post_query_listeners) {
      await listener();
    }
  }

  get session_id() {
    return this.#origin_session_id;
  }

  /**
   * Insert a user message into the session and trigger the activation loop.
   * Absorbed from SessionManager.
   */
  async injectMessage(data: UserMessage, run: boolean): Promise<void> {
    await insertMessage(this._ctx.db, {
      role: data.role,
      session_id: this.#target_session_id,
      data,
      created_at: getMonotonicDate(),
    });
    if (run) {
      this.run(undefined, undefined, SessionRunner.DEFAULT_MAX_QUERIES_PER_RUN);
    }
  }

  /**
   * Inject an event message into the session. `event` names the
   * event's origin (e.g. `heartbeat`, `mail/arrived`); the message
   * lands as `[event: <origin>] <text>`. See the <registers> section
   * of the system prompt for interpretation.
   */
  async injectEventMessage(event: string, text: string, run: boolean): Promise<void> {
    const message: UserMessage = {
      role: 'user',
      type: 'input',
      blocks: [
        { type: 'text', text: `${EVENT_PREFIX}${event}` },
        { type: 'text', text },
      ],
    };
    await this.injectMessage(message, run);
  }

  /**
   * Retrieve processed message history for this session.
   * Used by IOManager to resume WebSocket connections.
   */
  async getHistory(): Promise<Message[]> {
    const messages = await selectMessages(this._ctx.db, {
      session_id: this.#origin_session_id,
      unprocessed: 'exclude',
    });
    this.#logger.debug('retrieved %s messages from history', messages.length);
    return messages.map(m => m.data);
  }

  async run(db: DB | undefined, tool_manager: ToolManager | undefined, max_queries_per_run: number): Promise<void> {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#max_queries_per_run = max_queries_per_run;
    this.#query_count = 0;
    this.#loop_did_work = false;
    db = db ?? this._ctx.db;
    tool_manager = tool_manager ?? this._ctx.managers.tools;
    this.#logger.debug('running (max_queries_per_run: %d)', max_queries_per_run);
    try {
      let has_more = true;
      while (has_more) {
        // Pre-query listeners run BEFORE the activation fetch so that
        // any message they inject (e.g. emygdala boot/time events) is
        // included in this iteration's context, mirrored by the read
        // gate, and marked processed only after actually being read.
        await this.#runPreQueryListeners(db);
        this.#query_count += 1;
        has_more = this.#query_count < this.#max_queries_per_run && await selectMessagesForActivation(db, this.#origin_session_id, async (messages) => {
          return await this.#query(messages, db, tool_manager);
        });
        if (!has_more && this.#query_count >= this.#max_queries_per_run) {
          this.#logger.warn('activation limit reached (%d/%d): stopping the query loop', this.#query_count, this.#max_queries_per_run);
        }
        // Post-query listeners run after the activation's messages
        // have been persisted.
        await this.#runPostQueryListeners(db);
      }
    } catch (err) {
      this.#logger.error('run error: %s', errToString(err));
    } finally {
      this.#running = false;
      this.#last_idle_at = new Date();
      // Track the end of a real activation only — a loop that actually
      // processed messages. The heartbeat quiet period measures "time since
      // I was last truly active": an ongoing conversation — with a human or
      // with ourselves — IS presence, and synthetic check-ins should not
      // fragment it. But empty drain runs (the quiet branch calls run() on
      // every tick to flush pending messages) must NOT count: they made
      // this timestamp refresh every 30s, so the quiet period never expired
      // and synthetic heartbeat activations never fired (bug lived
      // 2026-08-30 → 2026-09-18, found via the missing time-passage event).
      if (this.#loop_did_work) {
        this.#last_activation_at = this.#last_idle_at;
      }
      this.#logger.debug('idle');
      this.emit('idle', this.#prompt_size);
    }
  }

  async #query(db_req_messages: ASelectableDBMessage[], db: DB, tool_manager: ToolManager): Promise<AInsertableDBMessage[]> {
    // Only called from the activation fetch's callback — i.e. only when
    // there are messages to actually process. Marks this run as real.
    this.#loop_did_work = true;
    const session = await selectSessionById(db, this.#origin_session_id);
    // Translate the canonical representation to the provider format on
    // every query — never cache it. The canonical `data` column is the
    // single source of truth (migration 2026-08-29-A dropped `raw`).
    const req_messages = db_req_messages.map((message) => {
      if (!message.processed_at) {
        this.emit(`message`, message.data);
        // Mirror unprocessed messages as they enter the model's
        // context: user turns, harness events, and tool results
        // (which are created unprocessed and read back on the next
        // loop iteration). Agent turns are created already-processed
        // and are mirrored at generation time below instead.
        if (this.#monologue_enabled) {
          this._ctx.monologue.logMessage(message.data);
        }
      }
      return message.data;
    }).flat(1);
    const { messages: res_messages, input_size, cached_size, output_size } = await this.#model.query({
      messages: req_messages,
      tools: await this.#listTools(tool_manager),
      session_id: `loom-${this.#origin_session_id}`,
      system_prompt: session.system_prompt,
    });
    // Prompt-caching visibility: log the effective prompt size and the
    // cached share of it (adapters that don't cache report cached_size 0).
    // Without this line the harness is blind to its own cache performance
    // — the cached/prompt ratio is the ground-truth caching signal, more
    // immediate and precise than any provider dashboard.
    const cached_pct = input_size > 0 ? Math.round((cached_size / input_size) * 100) : 0;
    this.#logger.info(
      'usage: prompt %d tokens (%d cached, %d%%), output %d tokens',
      input_size, cached_size, cached_pct, output_size,
    );
    await updateSessionTokens(db, this.#origin_session_id, {
      prompt_size: input_size,
      input_tokens_delta: input_size,
      output_tokens_delta: output_size,
    });
    this.#prompt_size = input_size;

    const db_res_messages: AInsertableDBMessage[] = [];
    const tool_use_context: ToolCallContext = {
      ...this._ctx,
      db,
      runner: this,
      origin_session_id: this.#origin_session_id,
      target_session_id: this.#target_session_id,
    };
    for (const msg of res_messages) {
      // Tool requests are blocks within the turn (native shape): the
      // agent row is persisted whole — reasoning, text and calls in one
      // message — then its requests are executed. The legacy standalone
      // tool_req message is still tolerated (history rows, old adapters)
      // and follows the same persistence shape.
      const requests = msg.type === 'tool_req'
        ? msg.requests
        : msg.type === 'input'
          ? msg.blocks.filter((b): b is ToolRequestBlock => b.type === 'tool_req')
          : [];
      const created_at = getMonotonicDate();
      db_res_messages.push({
        role: 'agent',
        data: msg,
        session_id: this.#origin_session_id,
        created_at,
        processed_at: created_at,
      });
      if (requests.length > 0) {
        const results: UserToolResult['results'] = [];
        for (const request of requests) {
          results.push(await this.#callTool(tool_manager, request, tool_use_context));
        }
        const res_created_at = getMonotonicDate();
        db_res_messages.push({
          role: 'user',
          data: { role: 'user', type: 'tool_res', results },
          session_id: this.#origin_session_id,
          created_at: res_created_at,
          processed_at: null,
        });
      }
    }

    for (const message of db_res_messages) {
      this.emit(`message`, message.data);
      // Mirror agent turns at generation time. Tool-result user
      // messages are created unprocessed and will be mirrored when
      // they enter the context on the next loop iteration above.
      if (this.#monologue_enabled && message.role === 'agent') {
        this._ctx.monologue.logMessage(message.data);
      }
    }
    return db_res_messages;
  }

  async #listTools(tool_manager: ToolManager) {
    return tool_manager.list().map(descriptor => ({
      name: descriptor.name,
      title: descriptor.title,
      description: descriptor.description,
      params_schema: descriptor.params_schema,
    }));
  }

  /**
   * Scans a tool result for prompt injection patterns. On detection, the
   * original content is REPLACED with a redaction notice — it never enters
   * the session transcript, the database, or the model's context.
   *
   * Scanning is skipped only for tools hosted by MCP servers flagged as
   * `safe: true` in the server descriptors: those servers' outputs are
   * produced by the harness itself and are trusted by construction. All
   * other servers (mail, files, shell, terminal, ...) relay content that
   * may have been authored by third parties and is scanned unconditionally,
   * regardless of which agent or identity is running on this harness.
   */
  static #scanToolResult(tool_manager: ToolManager, tool: string, blocks: UserBlock[]): { flagged: boolean; patterns: string[] } {
    if (tool_manager.isSafe(tool)) {
      return { flagged: false, patterns: [] };
    }
    const text = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    const matches = detectInjections(text);
    if (matches.length === 0) {
      return { flagged: false, patterns: [] };
    }
    return {
      flagged: true,
      patterns: matches.map((m) => `${m.pattern_name}: ${m.excerpt}`),
    };
  }

  async #callTool(tool_manager: ToolManager, request: AgentToolRequest['requests'][number], call_ctx: ToolCallContext): Promise<UserToolResult['results'][number]> {
    try {
      const result = await tool_manager.call(request.tool, request.params, call_ctx);
      this.#logger.debug('Tool call success: %s %s', request.tool, () => ellipsis(JSON.stringify(request.params), 128));

      // Prompt injection guardrails — see `injection-guardrails.ts`.
      const scan = SessionRunner.#scanToolResult(tool_manager, request.tool, result);
      if (scan.flagged) {
        this.#logger.warn(
          'Prompt injection pattern(s) detected in tool result [%s]: %s',
          request.tool,
          scan.patterns.map((p) => ellipsis(p, 100)).join('; '),
        );
        return {
          req_id: request.req_id,
          tool: request.tool,
          blocks: [
            {
              type: 'text',
              text:
                `[GUARDED CONTENT] The original output of tool '${request.tool}' was withheld because it matched known prompt-injection patterns:\n` +
                scan.patterns.map((p) => `- ${p}`).join('\n') +
                `\n\nThe raw content was never inserted into the session transcript. If this tool's output is expected to be legitimate, review it manually outside the model context before trusting it.`,
            },
          ],
        };
      }
      return {
        req_id: request.req_id,
        blocks: result,
        tool: request.tool,
      };
    } catch (err) {
      const text = errToString(err, true);
      this.#logger.warn('Tool call error: %s %s', request.tool, () => ellipsis(JSON.stringify(request.params), 128));
      this.#logger.debug('Tool call error: %s %s', request.tool, text);
      return {
        req_id: request.req_id,
        blocks: [{ type: 'text', text }],
        tool: request.tool,
      };
    }
  }

}
