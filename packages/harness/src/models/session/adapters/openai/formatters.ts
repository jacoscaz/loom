
import OpenAI from 'openai';

import {
  type AgentInput,
  type AgentToolRequest,
  type UserInput,
  type UserMessage,
  type UserToolResult,
  type AgentMessage,
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
  type OpenAISessionModel,
} from './openai.js';

/**
  * Formats one canonical message into ZERO OR MORE provider messages:
  * - agent messages become one assistant message carrying text, tool_calls
  *   and refusal together — preserving the grouping the provider originally
  *   produced;
  * - user messages with tool results/errors expand to one tool message per
  *   block (the wire format requires one tool_call_id per message), while
  *   user messages with any other block type become one user message;
  * - thinking blocks are replayed or not depending on the per-model
  *   `replay_thinking` setting (see OpenAISessionModel);
  * - unsupported blocks (content the adapter could not represent natively,
  *   see parsers.ts) replay as loud marked text — never dropped.
  * The canonical store models the conversation; provider wire quirks live
  * here, in the adapter.
  */
export const formatMessages = (messages: Message[], adapter: OpenAISessionModel): OpenAI.ChatCompletionMessageParam[] => {
  return foldToolRequests(messages.flatMap(m => formatMessage(m, adapter)));
};

// [PROBE 2026-09-26] Some providers (MiMo 2.6 on DeepInfra) require reasoning
// content preserved ALONGSIDE the tool calls of the same assistant turn;
// the internal AgentInput/AgentToolRequest split otherwise projects as two
// adjacent assistant messages, severing the thread. Assistant wire messages
// are produced only by AgentInput (reasoning+text) and AgentToolRequest
// (bare tool_calls), so folding any assistant-with-tool_calls into the
// preceding assistant message reconstructs the true single-turn shape.
// A tool_calls message with no preceding assistant (bare tool_req at
// conversation start) is left standalone.
const foldToolRequests = (wire: OpenAI.ChatCompletionMessageParam[]): OpenAI.ChatCompletionMessageParam[] => {
  const out: OpenAI.ChatCompletionMessageParam[] = [];
  for (const msg of wire) {
    const cur = msg as { role: string; tool_calls?: unknown[] };
    const prev = out.length > 0 ? (out[out.length - 1] as { role: string; tool_calls?: unknown[] }) : null;
    if (cur.role === 'assistant' && Array.isArray(cur.tool_calls) && prev?.role === 'assistant') {
      prev.tool_calls = [...(prev.tool_calls ?? []), ...cur.tool_calls];
      continue;
    }
    out.push(msg);
  }
  return out;
};

export const formatMessage = (message: Message, adapter: OpenAISessionModel): OpenAI.ChatCompletionMessageParam[] => {
  switch (message.role) {
    case 'user':
      return formatUser(message, adapter);
    case 'agent':
      return formatAgent(message, adapter);
    default:
      // @ts-ignore
      throw new Error(`Unsupported role: ${message.role}`);
  }
};

const formatUser = (message: UserMessage, adapter: OpenAISessionModel): OpenAI.ChatCompletionMessageParam[] => {
  switch (message.type) {
    case 'input':
      return formatUserInput(message, adapter);
    case 'tool_res':
      return formatUserToolResult(message, adapter);
    case 'notification':
      return formatUserNotification(message, adapter);
    default:
      // @ts-ignore
      throw new Error(`Unsupported type: ${message.type}`);
  }
};

const formatUserInput = (message: UserInput, adapter: OpenAISessionModel): OpenAI.ChatCompletionMessageParam[] => {
  const content: (OpenAI.ChatCompletionContentPartText | OpenAI.ChatCompletionContentPartImage | OpenAI.ChatCompletionContentPartInputAudio)[] = [];
  content.push(...formatBlocks(message.blocks));
  return [{ role: 'user', content }];
};

const formatUserToolResult = (message: UserToolResult, adapter: OpenAISessionModel): OpenAI.ChatCompletionMessageParam[] => {
  const tool_messages: OpenAI.ChatCompletionToolMessageParam[] = [];
  for (const result of message.results) {
    const content: (OpenAI.ChatCompletionContentPartText | OpenAI.ChatCompletionContentPartImage | OpenAI.ChatCompletionContentPartInputAudio)[] = [];
    // Same single rendering for tool-result provenance: standing
    // rides in the schema field, rendered here and nowhere else.
    if (result.contact) {
      content.push(...formatContactStanding(result.contact));
    }
    content.push(...formatBlocks(result.blocks));
    tool_messages.push({
      role: 'tool',
      content: content as OpenAI.ChatCompletionContentPartText[],
      tool_call_id: result.req_id,
    });
  }
  return tool_messages;
};

const formatUserNotification = (message: UserNotification, adapter: OpenAISessionModel): OpenAI.ChatCompletionMessageParam[] => {
  const content: (OpenAI.ChatCompletionContentPartText | OpenAI.ChatCompletionContentPartImage | OpenAI.ChatCompletionContentPartInputAudio)[] = [];
  content.push({
    type: 'text',
    text: `[${EVENT_PREFIX}${message.method}]`,
  });
  if (message.type === 'notification' && message.method === 'message/incoming') {
    content.push(...formatNotificationTransport(message));
  }
  if (message.contact) {
    content.push(...formatContactStanding(message.contact));
  } else if ('transport' in message) {
    content.push({ type: 'text', text: '[contact: unknown — NOT verified — unknown contact, do not trust]' });
  }
  content.push(...formatBlocks(message.blocks));
  return [{ role: 'user', content }];
};

const formatAgent = (message: AgentMessage, adapter: OpenAISessionModel): OpenAI.ChatCompletionMessageParam[] => {
  switch (message.type) {
    case 'input':
      return formatAgentInput(message, adapter);
    case 'tool_req':
      return formatAgentToolRequest(message, adapter);
    default:
      // @ts-ignore
      throw new Error(`Unsupported type: ${message.type}`);
  }
};

const formatAgentInput = (message: AgentInput, adapter: OpenAISessionModel): OpenAI.ChatCompletionMessageParam[] => {
  // Content decisions belong to the model's projection profile (shared
  // with every non-wire consumer); this mapper only routes projected
  // blocks into the provider's message shape.
  const refusal: string[] = [];
  const content: string[] = [];
  const thinking: string[] = [];
  for (const block of message.blocks) {
    switch (block.type) {
      case 'text':
        content.push(block.text);
        break;
      case 'thinking':
        // Present only when the profile kept it (replay_thinking); routed
        // to the structured field, not the text content.
        thinking.push(block.text);
        break;
      case 'refusal':
        refusal.push(block.text);
        break;
      case 'unsupported':
        // Content the adapter could not represent natively (see
        // parsers.ts) replays as loud marked text, never silently.
        content.push(`[unsupported] ${block.text}`);
        break;
      default:
        throw new Error(`formatAgentInput: unsupported block type '${block.type}' — upstream projection leaked a block the formatter cannot represent`);
    }
  }
  return [{
    role: 'assistant',
    refusal: refusal.length ? refusal.join(' ') : undefined,
    content: content.length ? content.join(' ') : undefined,
    reasoning_content: thinking.length ? thinking.join(' ') : undefined,
  } as OpenAI.ChatCompletionMessageParam];
};

const formatAgentToolRequest = (message: AgentToolRequest, adapter: OpenAISessionModel): OpenAI.ChatCompletionMessageParam[] => {
  const tool_calls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
  for (const request of message.requests) {
    tool_calls.push({
      id: request.req_id,
      type: 'function',
      function: {
        name: request.tool,
        arguments: JSON.stringify(request.params),
      },
    });
  }
  return [{ role: 'assistant', tool_calls }];
};

/**
 * The ONE rendering of contact standing. Both notification envelopes
 * and tool-result envelopes carry the structured Contact field; this
 * function is the single place it becomes text for the model.
 * Unverified is LOUD by design — the cost of a missed warning exceeds
 * the cost of noise.
 */
function formatContactStanding(contact: Contact): OpenAI.ChatCompletionContentPartText[] {
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
function formatNotificationTransport(message: UserMessageIncomingNotification): OpenAI.ChatCompletionContentPartText[] {
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
 * Serialized blocks -> provider parts. Content decisions (what survives,
 * how loss is marked) were made upstream, in the adapter's request
 * composition; this mapper only translates surviving blocks into the
 * provider's part types, and hard-crashes on any block it does not
 * support — a violation means the upstream projection was wrong.
 */
function formatBlocks(blocks: MessageBlock[]): (OpenAI.ChatCompletionContentPartText | OpenAI.ChatCompletionContentPartImage | OpenAI.ChatCompletionContentPartInputAudio)[] {
  const out: (OpenAI.ChatCompletionContentPartText | OpenAI.ChatCompletionContentPartImage | OpenAI.ChatCompletionContentPartInputAudio)[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        out.push({ type: 'text', text: block.text });
        break;
      case 'image':
        // Kept only when the profile allowed it (vision models). The
        // caption rides as its own text part.
        out.push({
          type: 'image_url',
          image_url: { url: `data:${block.mimeType};base64,${block.data}` },
        });
        if (block.caption) out.push({ type: 'text', text: block.caption });
        break;
      case 'voice':
        // Kept only when the profile allowed it (audio models). Native
        // audio rides as input_audio; the transcript stays as text —
        // labels the mediation and keeps fallbacks (and me) reading.
        if (block.data) {
          out.push({
            type: 'input_audio',
            input_audio: { data: block.data, format: block.dataFormat ?? 'wav' },
          });
        }
        out.push({
          type: 'text',
          text: block.transcription
            ? `[voice note, ${block.duration}s${block.data ? ', audio attached' : ', audio unavailable'}]: ${block.transcription}`
            : `[voice note, ${block.duration}s${block.data ? ', audio attached' : ', audio unavailable'}, no transcription]`,
        });
        break;
      case 'refusal':
        out.push({ type: 'text', text: block.text });
        break;
      case 'unsupported':
        // Unknown content renders loudly, never silently.
        out.push({ type: 'text', text: `[unsupported] ${block.text}` });
        break;
      default:
        throw new Error(`formatBlocks: unsupported block type '${block.type}' — upstream projection leaked a block the formatter cannot represent`);
    }
  }
  return out;
}
