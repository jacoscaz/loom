
import {
  AbstractSessionModel,
  type ModelQueryResults,
  type ModelQueryOpts,
} from "../../abstract.js";

import OpenAI from 'openai';

import { type ConfigModelOpenAI } from "../../../../config/config.js";
import { type ReasoningEffort } from "../../../../constants.js";
import { ChatCompletionMessageParam, ReasoningEffort as OpenAIReasoningEffort } from "openai/resources/index.mjs";
import { ChatCompletionStream } from "openai/lib/ChatCompletionStream.mjs";
import { formatMessages } from "./formatters.js";
import { projectMessages } from "../../../../projection.js";
import { parseMessage, warnOnTextualToolCalls } from "./parsers.js";


export class OpenAISessionModel extends AbstractSessionModel {
  #model: string;
  #client: OpenAI;
  #extras: Record<string, any>;
  #opts: ConfigModelOpenAI['options'];
  #reasoning: OpenAIReasoningEffort;

  constructor(opts: ConfigModelOpenAI) {
    super(opts);
    this.#model = opts.options.model;
    this.#extras = opts.options.extras ?? {};
    this.#opts = opts.options;
    this.#client = new OpenAI({
      apiKey: opts.options.api_key,
      baseURL: opts.options.base_url,
    });
    this.#reasoning = opts.options.reasoning?.effort ?? 'none';
  }

  /**
   * Runtime reasoning-effort update. The harness's common vocabulary maps
   * 1:1 onto the OpenAI-native values; unsupported requests are ignored
   * (log + false) rather than erroring — the switch itself must never fail
   * because an optional knob is missing (Jacopo's ruling, 2026-09-03).
   */
  override setReasoningEffort(effort: ReasoningEffort): boolean {
    if (this.#reasoning === 'none') {
      console.warn(`[openai-model ${this.#model}] reasoning effort requested but model was configured without reasoning — ignoring`);
      return false;
    }
    this.#reasoning = effort;
    return true;
  }

  get reasoningEffort(): ReasoningEffort {
    // OpenAI's type includes null (meaning "unset"); our vocabulary does not.
    return (this.#reasoning ?? 'none') as ReasoningEffort;
  }

  /**
   * How thinking blocks replay on the wire. 'field' (default) is the
   * DeepSeek-style `reasoning_content` extension. 'mistral' is Mistral's
   * documented shape (2026-10): assistant content is a list of typed
   * chunks (ThinkChunk/TextChunk) — `reasoning_content` on INPUT is
   * rejected as extra_forbidden (verified live, HTTP 422 with explicit
   * Pydantic detail). Declared per-model via options.thinking_wire_style
   * (adapter-level semantics, not provider passthrough).
   */
  get thinking_wire_style(): 'field' | 'mistral' {
    return this.#opts.thinking_wire_style === 'mistral' ? 'mistral' : 'field';
  }

  async _query(opts: ModelQueryOpts, signal?: AbortSignal, on_activity: () => void = () => { }): Promise<ModelQueryResults> {
    try {
      // Projection runs here, in request composition: content decisions
      // happen before serialization. The image policy is uniform across
      // message types: tool messages DO carry image parts on the wire
      // (empirically verified; the openai-node types excluding them are
      // stale — the formatter's cast bridges them). Formatters receive
      // only blocks they support and hard-crash otherwise.
      const projected = projectMessages(opts.messages, this.projection);
      const messages: ChatCompletionMessageParam[] = formatMessages(projected, this);
      messages.unshift({
        role: 'system',
        content: opts.system_prompt,
      } satisfies ChatCompletionMessageParam);
      // extras is reserved for provider-specific API passthrough and is
      // spread into the request body as-is; adapter-level keys
      // (thinking_wire_style, strict_wire) live at options level and are
      // never spread — providers like Mistral reject unknown body fields
      // with 422 extra_forbidden (live-verified 2026-10-07).
      const api_extras: Record<string, any> = { ...this.#extras };
      // Some providers reject unknown top-level params outright (Mistral:
      // 422 extra_forbidden on session_id, live-verified 2026-10-07); the
      // field has ridden in this request since the first commit but is not
      // a documented chat.completions parameter anywhere — strict models
      // opt out via options.strict_wire.
      const session_id = this.#opts.strict_wire ? undefined : opts.session_id;
      // AbortSignal rides in the REQUEST OPTIONS (second argument), never
      // in the body: the SDK forwards options.signal to the underlying
      // request, but a signal left in the params object is serialized into
      // the JSON body as `signal: {}` — which strict providers (Mistral)
      // reject with 422 extra_forbidden (captured live via a request
      // dump, 2026-10-07; it had ridden in every request since the first
      // commit, tolerated silently by lenient providers).
      const stream = this.#client.chat.completions.stream({
        ...api_extras,
        messages,
        max_tokens: opts.max_output_size ?? this.max_ouput_size,
        session_id,
        model: this.#model,
        reasoning_effort: this.#reasoning as OpenAIReasoningEffort,
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
        // Aborted by the session-model timeout wrapper on expiry; the SDK
        // then errors the stream itself (covering mid-stream stalls, which
        // the SDK's own time-to-headers timeout does not).
        signal,
      });
      const [response, usage] = await this.#consumeStream(stream, on_activity);
      const parsed_messages = parseMessage(response);
      // Loud, registry-bounded detection of tool calls the model emitted as
      // text instead of natively (2026-09-10 distiller incident: a
      // continuity_append arrived as malformed markup in a text block and
      // the write was silently lost). A warning only — never an action.
      warnOnTextualToolCalls(parsed_messages, opts.tools.map((t) => t.name), this.#model);
      return {
        messages: parsed_messages,
        input_size: usage.prompt_tokens,
        cached_size: usage.prompt_tokens_details?.cached_tokens ?? 0,
        output_size: usage.completion_tokens,
      };
    } catch (e) {
      throw new Error(`Failed to query OpenAI model: ${e}`);
    }
  }

  async #consumeStream(stream: ChatCompletionStream, on_activity: () => void): Promise<[OpenAI.ChatCompletionMessage, OpenAI.CompletionUsage]> {
    // The SDK's chunk accumulator only knows the standard Chat Completions
    // fields; provider extensions such as DeepSeek-style `reasoning_content`
    // (or OpenRouter's `reasoning`) fall through to an `Object.assign` that
    // OVERWRITES instead of concatenating, so `finalMessage()` would keep
    // only the LAST reasoning delta of the response (observed in production
    // as one-word "thinking" tails). Accumulate them ourselves and reattach
    // the full trace.
    let reasoning = '';
    let reasoning_alt = '';
    // Mistral-style block content: when reasoning is on, some providers
    // (documented deviation at docs.mistral.ai capabilities/reasoning)
    // stream `delta.content` as a LIST of typed chunks — ThinkChunk and
    // TextChunk — instead of a plain string. The SDK's accumulator only
    // knows string content, so we accumulate block content ourselves and
    // normalize the final message below.
    let block_content_text = '';
    let saw_block_content = false;
    // Per-chunk handler
    const onChunk = (chunk: OpenAI.ChatCompletionChunk) => {
      // Every received chunk re-arms the stall timeout: the model may think
      // server-side (reasoning, slow generation) for long stretches, and
      // that is health — silence is what indicates a hang.
      on_activity();
      // Accumulation of reasoning deltas to work around the SDK's overwrite
      // behavior.
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
    // Cleanup handlers for chunk and end/abort events.
    const onEndOrAbort = () => {
      stream.off('chunk', onChunk);
      stream.off('end', onEndOrAbort);
      stream.off('abort', onEndOrAbort);
    };
    // Attach event handlers to the stream.
    stream.on('chunk', onChunk);
    stream.on('end', onEndOrAbort);
    stream.on('abort', onEndOrAbort);
    // Wait for the stream to complete and return the response.
    const response = await stream.finalMessage();
    // Normalize Mistral-style block content: the final message gets a plain
    // string content, so every downstream consumer (parseMessage included)
    // sees the standard OpenAI shape.
    if (saw_block_content) {
      (response as unknown as Record<string, unknown>).content = block_content_text;
    }
    // Attach the accumulated reasoning to the response.
    const full_reasoning = reasoning || reasoning_alt;
    if (full_reasoning) {
      // `reasoning_content` is an unofficial extension to the OpenAI API
      // response, thus not supported by the official SDK.
      (response as unknown as Record<string, unknown>).reasoning_content = full_reasoning;
    }
    // Get the total usage from the stream.
    const usage = await stream.totalUsage();
    // Return the response and usage.
    return [response, usage];
  }

}
