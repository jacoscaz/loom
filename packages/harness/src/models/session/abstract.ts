
import { type ConfigModelBase, type ConfigModalities } from "../../config/config.js";

import { AgentMessage, Message } from "../../types/messages.js";
import { type ProjectOptions } from "../../projection.js";
import { withTimeout } from "@loom/utils";

export interface ModelQueryTool {
  name: string;
  title: string;
  description: string;
  params_schema: any;
}

export interface ModelQueryOpts {
  tools: ModelQueryTool[];
  messages: Message[];
  session_id: string;
  system_prompt: string;
  max_output_size?: number;
}

export interface ModelQueryResults {
  messages: AgentMessage[];
  input_size: number;
  cached_size: number;
  output_size: number;
}

export abstract class AbstractSessionModel {

  readonly #id: string;
  readonly #timeout: number;
  readonly #guidance?: string;
  readonly #max_output_size: number;
  readonly #max_context_size: number;
  readonly #modalities: ConfigModalities;
  readonly #replay_thinking: boolean;

  constructor(opts: ConfigModelBase) {
    this.#id = opts.id;
    this.#timeout = opts.timeout;
    this.#guidance = opts.guidance;
    this.#max_output_size = opts.max_output_size;
    this.#max_context_size = opts.max_context_size;
    this.#modalities = opts.modalities ?? {};
    this.#replay_thinking = opts.replay_thinking ?? false;
  }

  /** Harness-internal unique model identifier (e.g. 'z-ai/glm-5.3-flash'). */
  get id(): string {
    return this.#id;
  }

  /** Declarative selection guidance for the agent (may be undefined). */
  get guidance(): string | undefined {
    return this.#guidance;
  }

  get max_ouput_size(): number {
    return this.#max_output_size;
  }

  get max_context_size(): number {
    return this.#max_context_size
  }

  get supports_image_input(): boolean {
    return this.#modalities.images ?? false;
  }

  get supports_audio_input(): boolean {
    return this.#modalities.audio ?? false;
  }

  get replay_thinking(): boolean {
    return this.#replay_thinking;
  }

  /**
   * The model's projection profile: full ProjectOptions derived from the
   * session options, so adapters consume the SAME content-decision layer
   * as every non-wire consumer. Wire semantics declared here, once:
   * - wire content is never truncated (max_text_length: Infinity);
   * - thinking survives projection iff replay_thinking (the adapter then
   *   routes it to provider fields / applies validity gates);
   * - redacted reasoning marks its place;
   * - images are kept iff the model supports vision, voice never survives
   *   raw (no current wire carries native audio; projection extracts the
   *   transcription or emits the marker).
   */
  get projection(): ProjectOptions {
    return {
      max_text_length: Infinity,
      exclude_thinking: !this.#replay_thinking,
      thinking_redacted_policy: 'placeholder',
      exclude_tool_traffic: false,
      image_policy: (this.#modalities.images ?? false) ? 'keep' : 'placeholder',
      voice_policy: (this.#modalities.audio ?? false) ? 'keep' : 'placeholder',
    };
  }

  async query(opts: ModelQueryOpts): Promise<ModelQueryResults> {
    // STALL timeout, not total duration: the timer measures silence, not
    // progress. `_query` re-arms it on every stream chunk, so a query that
    // streams steadily for an hour is healthy while one that goes silent
    // (provider hang, dead connection, stuck generation) is aborted.
    //
    // On expiry, abort the in-flight request: the timer merely rejecting
    // the race would leave the underlying stream open (and any eventual
    // orphaned error would be an unhandled rejection). Aborting makes the
    // provider request itself fail, settling the abandoned promise.
    const controller = new AbortController();
    return withTimeout(
      (on_activity) => this._query(opts, controller.signal, on_activity),
      this.#timeout,
      `model query (${this.#id})`,
      () => controller.abort(),
    );
  }

  protected abstract _query(opts: ModelQueryOpts, signal?: AbortSignal, on_activity?: () => void): Promise<ModelQueryResults>;

  /**
   * Runtime reasoning-effort update, part of the dynamic substrate
   * switching design (2026-09-03): the session runner requests an effort
   * level from the harness's common vocabulary (REASONING_EFFORTS) and
   * the adapter translates to its native equivalent.
   *
   * Adapters with no notion of reasoning effort return false (no-op);
   * adapters whose config disables reasoning also return false. A switch
   * request must never ERROR because an optional knob is missing.
   */
  setReasoningEffort(_effort: string): boolean {
    return false;
  }

}
