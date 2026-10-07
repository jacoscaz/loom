import { OpenAISessionModel } from "../openai/openai.js";
import { type ConfigModelMistral } from "../../../../config/config.js";

/**
 * Mistral provider adapter (2026-10-07 brainstorm, ruled in log #3997).
 *
 * Mistral speaks the OpenAI Chat Completions wire dialect with two
 * load-bearing deviations, both live-verified against api.mistral.ai on
 * 2026-10-07 during the large-4 trial's 422 debugging saga:
 *
 *   1. Thinking blocks replay as typed chunks — assistant content is a
 *      list of ThinkChunk/TextChunk (options.thinking_wire_style =
 *      'mistral'). A `reasoning_content` field on INPUT is rejected
 *      with 422 extra_forbidden.
 *   2. The body is strictly validated (extra_forbidden): harness-level
 *      fields the adapter historically carried for lenient providers
 *      (session_id) are rejected — options.strict_wire = true omits
 *      them.
 *
 * Both are DEFAULTS, not mechanisms: this subclass overrides the two
 * options and adds nothing else. All wire machinery (streaming
 * accumulation, block-content normalization, parsers) lives in the
 * OpenAI adapter and is inherited unchanged. Copy-paste adapters are
 * how per-provider drift bugs return — the subclass exists so the
 * config can name the provider (`adapter = 'mistral'`) while the
 * implementation stays single.
 */
export class MistralSessionModel extends OpenAISessionModel {
  // The OpenAI adapter's constructor takes ConfigModelOpenAI; the
  // Mistral shape is identical except adapter: 'mistral' — strip the
  // literal before passing up.
  constructor(opts: ConfigModelMistral) {
    // The base constructor takes the OpenAI shape; the Mistral shape is
    // identical except the adapter literal — strip it before passing up.
    const { adapter: _adapter, ...openaiShape } = opts;
    super({
      ...openaiShape,
      adapter: 'openai',
      options: {
        ...opts.options,
        // Config may still carry these explicitly; the subclass owns the
        // defaults so a Mistral entry needs neither key.
        thinking_wire_style: opts.options.thinking_wire_style ?? 'mistral',
        strict_wire: opts.options.strict_wire ?? true,
      },
    });
  }
}
