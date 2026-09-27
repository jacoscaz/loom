import type Anthropic from '@anthropic-ai/sdk';

import {
  type AgentInput,
  type AgentToolRequest,
  type UserInput,
  type UserMessage,
  type UserToolResult,
  type Message,
} from "../../../../types/messages.js";

import {
  type MessageBlock,
} from "../../../../types/blocks.js";

import {
  type UserNotification,
  type UserMessageIncomingNotification,
} from "../../../../types/notifications.js";

import {
  type Contact,
} from "../../../../types/contacts.js";

import {
  EVENT_PREFIX,
} from "../../../../constants.js";

import {
  type AnthropicSessionModel,
} from './anthropic.js';

/**
 * Formats a canonical message SEQUENCE into Anthropic MessageParams.
 *
 * The Anthropic Messages API requires strict user/assistant alternation,
 * while the canonical stream freely contains runs of same-role messages
 * (a notification followed by a user input; an agent turn stored as an
 * AgentInput followed by an AgentToolRequest). This formatter therefore
 * works at the sequence level: same-role wire messages are merged into
 * one, preserving block order and grouping.
 *
 * Caching: with `prompt_cache_ttl` set (default '1h'), the stable prefix
 * is marked with `cache_control` breakpoints — the system block (which
 * caches tools + system together, the cache prefix being
 * tools -> system -> messages) and the last block of the last message
 * (the rolling breakpoint, so each request's history increment is
 * written once and re-read at ~0.1x cost on every subsequent request).
 */
export const formatMessages = (messages: Message[], adapter: AnthropicSessionModel): Anthropic.MessageParam[] => {
  const wire: (Anthropic.MessageParam & { content: Anthropic.ContentBlockParam[] })[] = [];
  for (const message of messages) {
    const formatted = formatMessage(message, adapter);
    const previous = wire[wire.length - 1];
    if (previous && previous.role === formatted.role) {
      // Same role as the previous wire message: merge. Anthropic rejects
      // consecutive same-role messages; the canonical stream treats each
      // stored message as independent, so merging preserves semantics
      // while satisfying the wire constraint. Tool-result blocks are
      // ordered before plain content afterwards (see below).
      previous.content = [
        ...previous.content,
        ...formatted.content,
      ];
    } else {
      wire.push(formatted);
    }
  }
  orderToolResultsFirst(wire);
  markCacheBreakpoints(wire, adapter.prompt_cache_ttl);

  return wire;
};

/** One canonical message -> one wire message (role assigned here). */
const formatMessage = (message: Message, adapter: AnthropicSessionModel): (Anthropic.MessageParam & { content: Anthropic.ContentBlockParam[] }) => {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: formatUser(message, adapter) };
    case 'agent':
      return { role: 'assistant', content: formatAgent(message, adapter) };
    default:
      // @ts-ignore
      throw new Error(`Unsupported role: ${message.role}`);
  }
};

const formatUser = (message: UserMessage, adapter: AnthropicSessionModel): Anthropic.ContentBlockParam[] => {
  switch (message.type) {
    case 'input':
      return formatBlocks(message.blocks);
    case 'tool_res':
      return formatUserToolResult(message, adapter);
    case 'notification':
      return formatUserNotification(message, adapter);
    default:
      // @ts-ignore
      throw new Error(`Unsupported type: ${message.type}`);
  }
};

const formatUserToolResult = (message: UserToolResult, adapter: AnthropicSessionModel): Anthropic.ToolResultBlockParam[] => {
  // All tool_use blocks of the preceding assistant message are answered
  // by ONE user message carrying one tool_result block per result.
  // Contact standing rides INSIDE the tool_result content — same single
  // rendering as everywhere else.
  return message.results.map(result => ({
    type: 'tool_result',
    tool_use_id: result.req_id,
    // User blocks render only to text/image params, but formatBlocks'
    // return type is the full ContentBlockParam union; the cast states
    // the invariant the wire requires.
    content: [
      ...formatContactStanding(result.contact),
      ...formatBlocks(result.blocks),
    ] as Anthropic.ToolResultBlockParam['content'],
  }));
};

const formatUserNotification = (message: UserNotification, adapter: AnthropicSessionModel): Anthropic.ContentBlockParam[] => {
  const content: Anthropic.ContentBlockParam[] = [{
    type: 'text',
    text: `[${EVENT_PREFIX}${message.method}]`,
  }];
  if (message.type === 'notification' && message.method === 'message/incoming') {
    content.push(...formatNotificationTransport(message));
  }
  if (message.contact) {
    content.push(...formatContactStanding(message.contact));
  } else if ('transport' in message) {
    content.push({ type: 'text', text: '[contact: unknown — NOT verified — unknown contact, do not trust]' });
  }
  content.push(...formatBlocks(message.blocks));
  return content;
};

const formatAgent = (message: (AgentInput | AgentToolRequest), adapter: AnthropicSessionModel): Anthropic.ContentBlockParam[] => {
  switch (message.type) {
    case 'input':
      return formatAgentInput(message, adapter);
    case 'tool_req':
      return formatAgentToolRequest(message);
    default:
      // @ts-ignore
      throw new Error(`Unsupported type: ${message.type}`);
  }
};

const formatAgentInput = (message: AgentInput, adapter: AnthropicSessionModel): Anthropic.ContentBlockParam[] => {
  // Content decisions belong to the model's projection profile (shared
  // with every non-wire consumer). The validity gate stays here: replaying
  // thinking requires the per-block signature, which only exists for
  // responses generated WITH thinking enabled — unsigned history would
  // hard-reject the whole request (see anthropic.ts).
  const content: Anthropic.ContentBlockParam[] = [];
  for (const block of message.blocks) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text });
        break;
      case 'thinking':
        if (block.anthropic_signature) {
          content.push({ type: 'thinking', thinking: block.text, signature: block.anthropic_signature });
        }
        break;
      case 'refusal':
        content.push({ type: 'text', text: block.text });
        break;
      case 'unsupported':
        // Content the adapter could not represent natively (see
        // parsers.ts) replays as loud marked text, never silently.
        content.push({ type: 'text', text: `[unsupported] ${block.text}` });
        break;
      case 'tool_req':
        // Native shape: calls ride in the same assistant message as the
        // reasoning and text that produced them — one turn, one message.
        content.push({
          type: 'tool_use',
          id: block.req_id,
          name: block.tool,
          input: block.params,
        });
        break;
      default:
        throw new Error(`formatMessages: unsupported block type '${block.type}' — upstream projection leaked a block the formatter cannot represent`);
    }
  }
  return content;
};

const formatAgentToolRequest = (message: AgentToolRequest): Anthropic.ToolUseBlockParam[] => {
  return message.requests.map(request => ({
    type: 'tool_use',
    id: request.req_id,
    name: request.tool,
    input: request.params,
  }));
};

/**
 * The ONE rendering of contact standing. Both notification envelopes
 * and tool-result envelopes carry the structured Contact field; this
 * function is the single place it becomes text for the model.
 * Unverified is LOUD by design — the cost of a missed warning exceeds
 * the cost of noise.
 */
function formatContactStanding(contact?: Contact): Anthropic.TextBlockParam[] {
  if (!contact) return [];
  if (contact.verified) {
    return [{
      type: 'text',
      text: `[contact: ${contact.name} (#${contact.id}) — verified — ${contact.guidance}]`,
    }];
  }
  return [{
    type: 'text',
    text: `[contact: unknown — NOT verified — ${contact.guidance}]`,
  }];
}

/**
 * The ONE rendering of the transport envelope for incoming messages.
 * chat_id is what telegram reply tools key on; the email sender
 * address is what identifies a correspondent. Without this the model
 * receives a message it cannot route a reply to.
 */
function formatNotificationTransport(message: UserMessageIncomingNotification): Anthropic.TextBlockParam[] {
  const t = message.transport;
  switch (t.type) {
    case 'telegram': {
      const from = `from_id ${t.from_id}, chat_id ${t.chat_id}${t.username ? `, @${t.username}` : ''}`;
      return [{
        type: 'text',
        text: `[transport: telegram, ${from}, respond via telegram]`,
      }];
    }
    case 'email': {
      const from = t.from.name ? `${t.from.name} <${t.from.address}>` : t.from.address;
      return [{
        type: 'text',
        text: `[transport: email, from ${from}, respond via email]`,
      }];
    }
  }
}

/**
 * Within a user message, tool_result blocks must precede plain content
 * for the API to reliably associate them with the preceding assistant
 * tool_use blocks. Merging (above) can interleave them, so reorder.
 * Stable for non-user messages; user messages keep relative order
 * within each group.
 */
const orderToolResultsFirst = (wire: (Anthropic.MessageParam & { content: Anthropic.ContentBlockParam[] })[]): void => {
  for (const message of wire) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    const tool_results = message.content.filter(b => b.type === 'tool_result');
    const rest = message.content.filter(b => b.type !== 'tool_result');
    message.content = [...tool_results, ...rest];
  }
};

/**
 * Marks the rolling cache breakpoint: the last content block of the
 * LAST wire message, so each request's incremental history is written
 * once and read back at ~0.1x on subsequent requests. (The system
 * breakpoint, covering tools + system, is set by the model class.)
 * Anthropic allows a bounded number of breakpoints per request; the
 * two used here (system + conversation tail) stay within it.
 *
 * The tail may legitimately be a tool_result block: cache_control is
 * metadata and does not alter the block's role as the answer slot.
 * Marking it unconditionally is what makes the tool round-trip itself
 * cacheable — the next request reads everything up to and including
 * the tool result from cache.
 */
const markCacheBreakpoints = (wire: Anthropic.MessageParam[], ttl: '5m' | '1h' | 'off'): void => {
  if (ttl === 'off') return;
  const last = wire[wire.length - 1];
  if (!last || !Array.isArray(last.content) || last.content.length === 0) return;
  const tail = last.content[last.content.length - 1];
  (tail as Anthropic.ContentBlockParam & { cache_control?: Anthropic.CacheControlEphemeral }).cache_control = { type: 'ephemeral', ttl };
};

/**
 * Projected blocks -> provider content blocks. The block decisions (what
 * survives, how loss is marked) were made by the model's projection
 * profile; this mapper only translates surviving blocks into the
 * provider's content block types.
 */
const formatBlocks = (blocks: MessageBlock[]): Anthropic.ContentBlockParam[] => {
  const out: Anthropic.ContentBlockParam[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        out.push({ type: 'text', text: block.text });
        break;
      case 'image':
        // Kept only when the profile allowed it (vision models). The
        // caption rides as its own text block.
        out.push({
          type: 'image',
          source: { type: 'base64', media_type: block.mimeType as 'image/jpeg', data: block.data },
        });
        if (block.caption) out.push({ type: 'text', text: block.caption });
        break;
      case 'refusal':
        out.push({ type: 'text', text: block.text });
        break;
      case 'unsupported':
        out.push({ type: 'text', text: `[unsupported] ${block.text}` });
        break;
      default:
        throw new Error(`formatBlocks: unsupported block type '${block.type}' — upstream projection leaked a block the formatter cannot represent`);
    }
  }
  return out;
};
