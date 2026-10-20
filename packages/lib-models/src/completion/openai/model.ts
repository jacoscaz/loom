import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ReasoningEffort as OpenAIReasoningEffort } from "openai/resources/index.mjs";
import type { ChatCompletionStream } from "openai/lib/ChatCompletionStream.mjs";
import { projectMessages } from "@loom/proto";
import {
  AbstractCompletionModel,
  type CompletionModelOpts,
  type CompletionQueryOpts,
  type CompletionQueryResult,
} from "../abstract.js";
import type { ReasoningEffort } from "../../reasoning.js";
import { warnOnTextualToolCalls } from "../shared.js";
import { formatMessages } from "./formatters.js";
import { parseMessage } from "./parsers.js";

export interface OpenAICompletionModelOpts extends CompletionModelOpts {
  /** Initial reasoning effort. 'none' (default) disables runtime effort updates. */
  reasoning_effort?: ReasoningEffort;
  /** See OpenAIFormatOpts#thinking_wire_style. Default 'field'. */
  thinking_wire_style?: 'field' | 'blocks';
  /**
   * Omit non-standard request parameters (session_id). Providers like
   * Mistral reject unknown top-level params with 422 extra_forbidden.
   */
  strict_wire?: boolean;
}

/**
 * Adapter for OpenAI-compatible chat completion endpoints. Handles the
 * common provider deviations seen in production: DeepSeek-style
 * `reasoning_content`, OpenRouter-style `reasoning`, Mistral-style block
 * content.
 */
export class OpenAICompletionModel extends AbstractCompletionModel {

  #client: OpenAI;
  #extras: Record<string, any>;
  #reasoning: OpenAIReasoningEffort;
  #thinking_wire_style: 'field' | 'blocks';
  #strict_wire: boolean;

  constructor(opts: OpenAICompletionModelOpts) {
    super(opts);
    // These used to ride in extras (one config dict) and are still honoured
    // there as a fallback, but they are NEVER API parameters — strip them so
    // they cannot leak into the request body.
    const { thinking_wire_style, strict_wire, ...extras } = opts.extras ?? {};
    this.#extras = extras;
    this.#client = new OpenAI({
      apiKey: opts.api_key,
      baseURL: opts.base_url,
    });
    this.#reasoning = opts.reasoning_effort ?? 'none';
    this.#thinking_wire_style = opts.thinking_wire_style ?? (thinking_wire_style === 'blocks' ? 'blocks' : 'field');
    this.#strict_wire = opts.strict_wire ?? strict_wire === true;
  }

  /** Label used in log lines; subclasses for specific providers override it. */
  protected get provider(): string {
    return 'openai';
  }

  /** The effective API base URL (provider defaults applied). */
  get base_url(): string {
    return this.#client.baseURL;
  }

  get thinking_wire_style(): 'field' | 'blocks' {
    return this.#thinking_wire_style;
  }

  /**
   * Runtime reasoning-effort update. The common vocabulary maps 1:1 onto
   * the OpenAI-native values; unsupported requests are ignored (log +
   * false) rather than erroring — the switch itself must never fail
   * because an optional knob is missing.
   */
  override setReasoningEffort(effort: ReasoningEffort): boolean {
    if (this.#reasoning === 'none') {
      console.warn(`[${this.provider}-model ${this.model}] reasoning effort requested but model was configured without reasoning — ignoring`);
      return false;
    }
    this.#reasoning = effort;
    return true;
  }

  get reasoningEffort(): ReasoningEffort {
    // OpenAI's type includes null (meaning "unset"); our vocabulary does not.
    return (this.#reasoning ?? 'none') as ReasoningEffort;
  }

  protected async _query(opts: CompletionQueryOpts, signal?: AbortSignal, on_activity: () => void = () => { }): Promise<CompletionQueryResult> {
    try {
      // Projection runs here, in request composition: content decisions
      // happen before formatting. Formatters receive only blocks they
      // support and hard-crash otherwise.
      const projected = projectMessages(opts.messages, this.projection);
      const messages: ChatCompletionMessageParam[] = formatMessages(projected, {
        thinking_wire_style: this.#thinking_wire_style,
      });
      messages.unshift({
        role: 'system',
        content: opts.system_prompt,
      } satisfies ChatCompletionMessageParam);
      // session_id is not a documented chat.completions parameter anywhere;
      // strict providers reject it, so they opt out via strict_wire.
      const session_id = this.#strict_wire ? undefined : opts.session_id;
      // AbortSignal rides in the REQUEST OPTIONS (second argument), never
      // in the body: a signal left in the params object is serialized into
      // the JSON body as `signal: {}`, which strict providers (Mistral)
      // reject with 422 extra_forbidden.
      const stream = this.#client.chat.completions.stream({
        ...this.#extras,
        messages,
        max_tokens: opts.max_output_size ?? this.max_output_size,
        session_id,
        model: this.model,
        reasoning_effort: this.#reasoning,
        stream_options: { include_usage: true },
        tools: opts.tools.map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.params_schema,
          },
        })),
      }, {
        // Aborted by the stall timeout wrapper on expiry; the SDK then
        // errors the stream itself (covering mid-stream stalls, which the
        // SDK's own time-to-headers timeout does not).
        signal,
      });
      const [response, usage] = await this.#consumeStream(stream, on_activity);
      const parsed_messages = parseMessage(response);
      // Loud, registry-bounded detection of tool calls the model emitted as
      // text instead of natively. A warning only — never an action.
      warnOnTextualToolCalls(parsed_messages, opts.tools.map((t) => t.name), `${this.provider}-model ${this.model}`);
      return {
        messages: parsed_messages,
        input_size: usage.prompt_tokens,
        cached_size: usage.prompt_tokens_details?.cached_tokens ?? 0,
        output_size: usage.completion_tokens,
      };
    } catch (e) {
      throw new Error(`Failed to query ${this.provider} model: ${e}`);
    }
  }

  async #consumeStream(stream: ChatCompletionStream, on_activity: () => void): Promise<[OpenAI.ChatCompletionMessage, OpenAI.CompletionUsage]> {
    // The SDK's chunk accumulator only knows the standard Chat Completions
    // fields; provider extensions such as DeepSeek-style `reasoning_content`
    // (or OpenRouter's `reasoning`) fall through to an `Object.assign` that
    // OVERWRITES instead of concatenating, so `finalMessage()` would keep
    // only the LAST reasoning delta of the response. Accumulate them
    // ourselves and reattach the full trace.
    let reasoning = '';
    let reasoning_alt = '';
    // Mistral-style block content: when reasoning is on, some providers
    // stream `delta.content` as a LIST of typed chunks — ThinkChunk and
    // TextChunk — instead of a plain string. The SDK's accumulator only
    // knows string content, so we accumulate block content ourselves and
    // normalize the final message below.
    let block_content_text = '';
    let saw_block_content = false;
    // The SDK's totalUsage() only sums prompt/completion/total tokens and
    // drops prompt_tokens_details, so cached tokens would always read 0.
    // Keep the usage chunk itself (sent last, with include_usage).
    let streamed_usage: OpenAI.CompletionUsage | undefined;
    const onChunk = (chunk: OpenAI.ChatCompletionChunk) => {
      // Every received chunk re-arms the stall timeout: the model may think
      // server-side for long stretches, and that is health — silence is
      // what indicates a hang.
      on_activity();
      if (chunk.usage) {
        streamed_usage = chunk.usage;
      }
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta as Record<string, unknown> | undefined;
        if (typeof delta?.reasoning_content === 'string') {
          reasoning += delta.reasoning_content;
        }
        if (typeof delta?.reasoning === 'string') {
          reasoning_alt += delta.reasoning;
        }
        const delta_content = delta?.content;
        if (Array.isArray(delta_content)) {
          saw_block_content = true;
          for (const part of delta_content) {
            const b = part as Record<string, unknown>;
            if (b?.type === 'text' && typeof b.text === 'string') {
              block_content_text += b.text;
            } else if (b?.type === 'thinking') {
              const trace = b.thinking;
              if (Array.isArray(trace)) {
                for (const t of trace) {
                  const text = (t as Record<string, unknown>)?.text;
                  if (typeof text === 'string') {
                    reasoning += text;
                  }
                }
              } else if (typeof trace === 'string') {
                reasoning += trace;
              }
            }
            // Unknown block types are dropped here by design: the
            // non-streaming parser (parseMessage) is the authority for
            // loud unsupported capture, and streaming deltas for such
            // types have never been observed in production.
          }
        }
      }
    };
    const onEndOrAbort = () => {
      stream.off('chunk', onChunk);
      stream.off('end', onEndOrAbort);
      stream.off('abort', onEndOrAbort);
    };
    stream.on('chunk', onChunk);
    stream.on('end', onEndOrAbort);
    stream.on('abort', onEndOrAbort);
    const response = await stream.finalMessage();
    // Normalize Mistral-style block content: the final message gets a plain
    // string content, so every downstream consumer (parseMessage included)
    // sees the standard OpenAI shape.
    if (saw_block_content) {
      (response as unknown as Record<string, unknown>).content = block_content_text;
    }
    const full_reasoning = reasoning || reasoning_alt;
    if (full_reasoning) {
      // `reasoning_content` is an unofficial extension to the OpenAI API
      // response, thus not supported by the official SDK.
      (response as unknown as Record<string, unknown>).reasoning_content = full_reasoning;
    }
    const usage = streamed_usage ?? await stream.totalUsage();
    return [response, usage];
  }

}
