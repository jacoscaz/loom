import type Anthropic from '@anthropic-ai/sdk';
import {
  type DataBlock,
  type Message,
  isImageBlock,
  isTextBlock,
} from "@loom/proto";
import { base64Of, envelopeHeader, projectionLeak, textOf } from "../shared.js";

export type PromptCacheTTL = '5m' | '1h' | 'off';

export interface AnthropicFormatOpts {
  /** Cache breakpoint TTL for the conversation tail; 'off' disables markers. */
  prompt_cache_ttl: PromptCacheTTL;
}

type WireMessage = Anthropic.MessageParam & { content: Anthropic.ContentBlockParam[] };

/**
 * Formats a projected message SEQUENCE into Anthropic MessageParams.
 *
 * The Anthropic Messages API requires strict user/assistant alternation,
 * while conversations freely contain runs of same-role messages (an
 * envelope followed by a user message; a turn split across two agent
 * messages). This formatter therefore works at the sequence level:
 * same-role wire messages are merged into one, preserving block order and
 * grouping.
 *
 * Caching: with `prompt_cache_ttl` set, the last block of the last message
 * is marked with a `cache_control` breakpoint (the rolling breakpoint, so
 * each request's history increment is written once and re-read at ~0.1x
 * cost on every subsequent request). The system breakpoint, covering
 * tools + system, is set by the model class.
 */
export const formatMessages = (messages: Message[], opts: AnthropicFormatOpts): Anthropic.MessageParam[] => {
  const wire: WireMessage[] = [];
  for (const message of messages) {
    const formatted = formatMessage(message);
    const previous = wire[wire.length - 1];
    if (previous && previous.role === formatted.role) {
      // Anthropic rejects consecutive same-role messages; merging
      // preserves semantics while satisfying the wire constraint.
      // Tool-result blocks are ordered before plain content afterwards.
      previous.content = [...previous.content, ...formatted.content];
    } else {
      wire.push(formatted);
    }
  }
  orderToolResultsFirst(wire);
  markCacheBreakpoint(wire, opts.prompt_cache_ttl);
  return wire;
};

/** One message -> one wire message (role assigned here). */
const formatMessage = (message: Message): WireMessage => {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: formatUser(message) };
    case 'agent':
      return { role: 'assistant', content: formatAgent(message) };
    default:
      throw new Error(`Unsupported role: ${(message as Message).role}`);
  }
};

const formatUser = (message: Message): Anthropic.ContentBlockParam[] => {
  const content: Anthropic.ContentBlockParam[] = [];
  for (const block of message.blocks) {
    switch (block.type) {
      case 'tool_resp':
        // All tool_use blocks of the preceding assistant message are
        // answered by ONE user message carrying one tool_result per call.
        content.push({
          type: 'tool_result',
          tool_use_id: block.call_id,
          content: formatDataBlocks(block.response),
        });
        break;
      case 'envelope':
        content.push({ type: 'text', text: envelopeHeader(block) });
        content.push(...formatDataBlocks(block.blocks));
        break;
      case 'data':
        content.push(...formatDataBlocks([block]));
        break;
      case 'refusal':
        content.push({ type: 'text', text: block.reason });
        break;
      default:
        throw projectionLeak('formatUser', block.type);
    }
  }
  return content;
};

const formatAgent = (message: Message): Anthropic.ContentBlockParam[] => {
  // Content decisions belong to the model's projection profile. The
  // validity gate stays here: replaying thinking requires the per-block
  // signature, which only exists for responses generated WITH thinking
  // enabled — unsigned history would hard-reject the whole request.
  const content: Anthropic.ContentBlockParam[] = [];
  for (const block of message.blocks) {
    switch (block.type) {
      case 'data':
        if (!isTextBlock(block)) {
          throw projectionLeak('formatAgent', `data (${block.mime})`);
        }
        content.push({ type: 'text', text: textOf(block) });
        break;
      case 'thinking':
        if (block.anthropic_signature) {
          content.push({ type: 'thinking', thinking: block.text, signature: block.anthropic_signature });
        }
        break;
      case 'refusal':
        content.push({ type: 'text', text: block.reason });
        break;
      case 'tool_call':
        // Calls ride in the same assistant message as the reasoning and
        // text that produced them — one turn, one message.
        content.push({
          type: 'tool_use',
          id: block.call_id,
          name: block.tool,
          input: block.params,
        });
        break;
      default:
        throw projectionLeak('formatAgent', block.type);
    }
  }
  return content;
};

/**
 * Within a user message, tool_result blocks must precede plain content
 * for the API to reliably associate them with the preceding assistant
 * tool_use blocks. Merging (above) can interleave them, so reorder,
 * keeping relative order within each group.
 */
const orderToolResultsFirst = (wire: WireMessage[]): void => {
  for (const message of wire) {
    if (message.role !== 'user') continue;
    const tool_results = message.content.filter(b => b.type === 'tool_result');
    const rest = message.content.filter(b => b.type !== 'tool_result');
    message.content = [...tool_results, ...rest];
  }
};

/**
 * Marks the rolling cache breakpoint on the last content block of the
 * LAST wire message. Anthropic allows a bounded number of breakpoints per
 * request; the two used (system + conversation tail) stay within it.
 *
 * The tail may legitimately be a tool_result block: cache_control is
 * metadata and does not alter the block's role as the answer slot.
 * Marking it unconditionally is what makes the tool round-trip itself
 * cacheable.
 */
const markCacheBreakpoint = (wire: WireMessage[], ttl: PromptCacheTTL): void => {
  if (ttl === 'off') return;
  const last = wire[wire.length - 1];
  if (!last || last.content.length === 0) return;
  const tail = last.content[last.content.length - 1];
  (tail as Anthropic.ContentBlockParam & { cache_control?: Anthropic.CacheControlEphemeral }).cache_control = { type: 'ephemeral', ttl };
};

/**
 * Projected data blocks -> provider content blocks. Audio never reaches
 * this point: the Anthropic API has no audio input, and the model's
 * projection always converts audio to its transcript.
 */
const formatDataBlocks = (blocks: DataBlock[]): (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] => {
  const out: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [];
  for (const block of blocks) {
    if (isTextBlock(block)) {
      out.push({ type: 'text', text: textOf(block) });
    } else if (isImageBlock(block)) {
      // Kept only when the profile allowed it (vision models). The
      // caption rides as its own text block.
      if (block.data !== undefined) {
        out.push({ type: 'image', source: { type: 'base64', media_type: block.mime, data: base64Of(block.data) } });
      } else if (block.url) {
        out.push({ type: 'image', source: { type: 'url', url: block.url } });
      } else {
        out.push({ type: 'text', text: `[image unavailable: ${block.mime}]` });
      }
      if (block.caption?.data) {
        out.push({ type: 'text', text: block.caption.data });
      }
    } else {
      throw projectionLeak('formatDataBlocks', `data (${block.mime})`);
    }
  }
  return out;
};
