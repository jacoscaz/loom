import { withTimeout } from "@loom/utils";
import type { Message, ProjectOptions, ToolDeclBlock } from "@loom/proto";
import type { ReasoningEffort } from "../reasoning.js";

export interface CompletionModalities {
  images?: boolean;
  /** Model accepts native audio input (audio data blocks ride as audio parts). */
  audio?: boolean;
}

/** Options shared by every completion model, regardless of provider. */
export interface CompletionModelOpts {
  /** Provider-side model name (e.g. 'claude-sonnet-4-5', 'z-ai/glm-5.3'). */
  model: string;
  api_key: string;
  base_url?: string;
  /** Stall timeout for queries, in milliseconds (see AbstractCompletionModel#query). */
  timeout: number;
  max_output_size: number;
  max_context_size: number;
  modalities?: CompletionModalities;
  /**
   * Whether thinking blocks should be included in inference requests.
   * Depends on the model. True for DeepSeek and Anthropic, false for
   * most others.
   */
  replay_thinking?: boolean;
  /** Provider-specific request body parameters, spread into every request. */
  extras?: Record<string, any>;
}

export interface CompletionQueryOpts {
  tools: ToolDeclBlock[];
  messages: Message[];
  system_prompt: string;
  /** Forwarded to providers that accept it (see OpenAICompletionModelOpts#strict_wire). */
  session_id?: string;
  max_output_size?: number;
}

export interface CompletionQueryResult {
  /** Zero or one agent message: one response maps to one turn. */
  messages: Message[];
  input_size: number;
  cached_size: number;
  output_size: number;
}

export abstract class AbstractCompletionModel {

  readonly #model: string;
  readonly #timeout: number;
  readonly #max_output_size: number;
  readonly #max_context_size: number;
  readonly #modalities: CompletionModalities;
  readonly #replay_thinking: boolean;

  constructor(opts: CompletionModelOpts) {
    this.#model = opts.model;
    this.#timeout = opts.timeout;
    this.#max_output_size = opts.max_output_size;
    this.#max_context_size = opts.max_context_size;
    this.#modalities = opts.modalities ?? {};
    this.#replay_thinking = opts.replay_thinking ?? false;
  }

  /** Provider-side model name. */
  get model(): string {
    return this.#model;
  }

  get max_output_size(): number {
    return this.#max_output_size;
  }

  get max_context_size(): number {
    return this.#max_context_size;
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
   * model options, so adapters consume the SAME content-decision layer
   * as every non-wire consumer. Wire semantics declared here, once:
   * - wire content is never truncated (max_text_length: Infinity);
   * - thinking survives projection iff replay_thinking (the adapter then
   *   routes it to provider fields / applies validity gates);
   * - redacted reasoning marks its place;
   * - images are kept iff the model supports vision; audio is kept raw
   *   iff the model supports audio input, under the per-prompt audio
   *   window — providers cap how many audio parts a single request may
   *   carry.
   */
  get projection(): ProjectOptions {
    return {
      max_text_length: Infinity,
      exclude_thinking: !this.#replay_thinking,
      thinking_redacted_policy: 'placeholder',
      exclude_tool_traffic: false,
      image_policy: this.supports_image_input ? 'keep' : 'placeholder',
      audio_policy: this.supports_audio_input ? 'keep' : 'placeholder',
      // DeepInfra/MiMo caps input_audio at 2 per prompt (a third voice
      // note in one session's history got the whole request rejected).
      // The transcript is the guaranteed channel, so older notes age out
      // to transcript in projection.
      audio_window: 2,
    };
  }

  async query(opts: CompletionQueryOpts): Promise<CompletionQueryResult> {
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
      `model query (${this.#model})`,
      () => controller.abort(),
    );
  }

  protected abstract _query(opts: CompletionQueryOpts, signal?: AbortSignal, on_activity?: () => void): Promise<CompletionQueryResult>;

  /**
   * Runtime reasoning-effort update: callers request an effort level from
   * the common vocabulary (REASONING_EFFORTS) and the adapter translates
   * to its native equivalent.
   *
   * Adapters with no notion of reasoning effort return false (no-op);
   * adapters whose options disable reasoning also return false. A switch
   * request must never ERROR because an optional knob is missing.
   */
  setReasoningEffort(_effort: ReasoningEffort): boolean {
    return false;
  }

}
