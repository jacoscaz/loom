import Anthropic from '@anthropic-ai/sdk';
import { type ProjectOptions, projectMessages } from "@loom/proto";
import {
  AbstractCompletionModel,
  type CompletionModelOpts,
  type CompletionQueryOpts,
  type CompletionQueryResult,
} from "../abstract.js";
import type { ReasoningEffort } from "../../reasoning.js";
import { warnOnTextualToolCalls } from "../shared.js";
import { formatMessages, type PromptCacheTTL } from "./formatters.js";
import { parseMessage } from "./parsers.js";

export interface AnthropicCompletionModelOpts extends CompletionModelOpts {
  /**
   * Prompt-caching breakpoint TTL for the stable prefix (system +
   * conversation tail). 'off' disables cache_control markers entirely.
   * Default '1h' — the 5m default expires across heartbeat-spaced
   * activations.
   */
  prompt_cache_ttl?: PromptCacheTTL;
}

export class AnthropicCompletionModel extends AbstractCompletionModel {

  #client: Anthropic;
  #extras: Record<string, any>;
  #prompt_cache_ttl: PromptCacheTTL;

  constructor(opts: AnthropicCompletionModelOpts) {
    super(opts);
    this.#extras = opts.extras ?? {};
    this.#client = new Anthropic({
      apiKey: opts.api_key,
      baseURL: opts.base_url,
    });
    // Default 1h: the default 5m cache lifetime barely survives an active
    // exchange, while activations are often minutes-to-hours apart; 1h
    // doubles the write cost (2x vs 1.25x base input) but keeps the stable
    // prefix cacheable across "human replies within the hour" patterns.
    this.#prompt_cache_ttl = opts.prompt_cache_ttl ?? '1h';
  }

  get prompt_cache_ttl(): PromptCacheTTL {
    return this.#prompt_cache_ttl;
  }

  /**
   * The Anthropic Messages API has no audio input: audio always projects
   * to its transcript, regardless of the declared modalities.
   */
  override get projection(): ProjectOptions {
    return { ...super.projection, audio_policy: 'placeholder' };
  }

  /**
   * Runtime reasoning-effort update. This adapter does not request
   * extended thinking yet: thinking replay requires the per-block
   * signature to have been persisted, and unsigned history would
   * hard-reject tool-use rounds. The common vocabulary maps poorly onto
   * Anthropic's budget-based thinking; a future version may translate.
   */
  override setReasoningEffort(effort: ReasoningEffort): boolean {
    console.warn(`[anthropic-model ${this.model}] reasoning effort '${effort}' requested but extended thinking is not yet wired in the anthropic adapter — ignoring`);
    return false;
  }

  protected async _query(opts: CompletionQueryOpts, signal?: AbortSignal, on_activity: () => void = () => { }): Promise<CompletionQueryResult> {
    try {
      // Projection runs here, in request composition — content decisions
      // before formatting; formatters only map and hard-crash on any block
      // they do not support.
      const projected = projectMessages(opts.messages, this.projection);
      const messages = formatMessages(projected, { prompt_cache_ttl: this.#prompt_cache_ttl });
      // The cache prefix is tools -> system -> messages: marking the
      // system block caches tools + system together (the heavy, fully
      // stable head of every request).
      const system: Anthropic.TextBlockParam[] = [{
        type: 'text',
        text: opts.system_prompt,
        ...(this.#prompt_cache_ttl !== 'off' ? { cache_control: { type: 'ephemeral', ttl: this.#prompt_cache_ttl } } : {}),
      }];
      const stream = this.#client.messages.stream({
        ...this.#extras,
        model: this.model,
        max_tokens: opts.max_output_size ?? this.max_output_size,
        system,
        messages,
        tools: opts.tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.params_schema as Anthropic.Tool.InputSchema,
        })),
      }, {
        // Aborted by the stall timeout wrapper on expiry; the SDK then
        // errors the stream itself.
        signal,
      });
      // Every received event re-arms the stall timeout.
      stream.on('streamEvent', () => on_activity());
      const response = await stream.finalMessage();
      const parsed_messages = parseMessage(response);
      warnOnTextualToolCalls(parsed_messages, opts.tools.map((t) => t.name), `anthropic-model ${this.model}`);
      const usage = response.usage;
      // Anthropic reports cache reads/writes separately from uncached
      // input; callers want the FULL effective prompt size (input +
      // cache_creation + cache_read), with the cached share broken out.
      return {
        messages: parsed_messages,
        input_size: (usage.input_tokens ?? 0)
          + (usage.cache_creation_input_tokens ?? 0)
          + (usage.cache_read_input_tokens ?? 0),
        cached_size: usage.cache_read_input_tokens ?? 0,
        output_size: usage.output_tokens,
      };
    } catch (e) {
      throw new Error(`Failed to query Anthropic model: ${e}`);
    }
  }

}
