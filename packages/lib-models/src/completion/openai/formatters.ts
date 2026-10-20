import type OpenAI from 'openai';
import {
  type AudioBlock,
  type DataBlock,
  type Message,
  isAudioBlock,
  isImageBlock,
  isTextBlock,
} from "@loom/proto";
import { base64Of, envelopeHeader, projectionLeak, textOf } from "../shared.js";

export interface OpenAIFormatOpts {
  /**
   * How thinking blocks replay on the wire. 'field' (default) is the
   * DeepSeek-style `reasoning_content` extension. 'blocks' is Mistral's
   * documented shape: assistant content is a list of typed chunks
   * (ThinkChunk/TextChunk) — `reasoning_content` on INPUT is rejected as
   * extra_forbidden (verified live, HTTP 422).
   */
  thinking_wire_style: 'field' | 'blocks';
}

type UserPart =
  | OpenAI.ChatCompletionContentPartText
  | OpenAI.ChatCompletionContentPartImage
  | OpenAI.ChatCompletionContentPartInputAudio;

/**
 * Formats projected messages into OpenAI chat messages:
 * - agent messages become one assistant message carrying text, thinking,
 *   tool_calls and refusal together — preserving the grouping the provider
 *   originally produced;
 * - user messages expand to one tool message per tool_resp block (the wire
 *   format requires one tool_call_id per message), followed by one user
 *   message carrying every other block (data, envelopes);
 * - thinking blocks reach the formatter only when the projection kept them
 *   (replay_thinking) and are routed per `thinking_wire_style`.
 * The conversation is modelled by lib-proto blocks; provider wire quirks
 * live here, in the adapter.
 */
export const formatMessages = (messages: Message[], opts: OpenAIFormatOpts): OpenAI.ChatCompletionMessageParam[] => {
  return foldToolCalls(messages.flatMap(m => formatMessage(m, opts)));
};

export const formatMessage = (message: Message, opts: OpenAIFormatOpts): OpenAI.ChatCompletionMessageParam[] => {
  switch (message.role) {
    case 'user':
      return formatUser(message);
    case 'agent':
      return formatAgent(message, opts);
    default:
      throw new Error(`Unsupported role: ${(message as Message).role}`);
  }
};

// Some providers (MiMo 2.6 on DeepInfra) require reasoning content
// preserved ALONGSIDE the tool calls of the same assistant turn. A turn
// split across two agent messages (text, then bare tool calls) would
// otherwise project as two adjacent assistant messages, severing the
// thread: fold any assistant-with-tool_calls into a preceding assistant
// message. A tool_calls message with no preceding assistant stays
// standalone.
const foldToolCalls = (wire: OpenAI.ChatCompletionMessageParam[]): OpenAI.ChatCompletionMessageParam[] => {
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

const formatUser = (message: Message): OpenAI.ChatCompletionMessageParam[] => {
  const tool_messages: OpenAI.ChatCompletionToolMessageParam[] = [];
  const content: UserPart[] = [];
  for (const block of message.blocks) {
    switch (block.type) {
      case 'tool_resp':
        tool_messages.push({
          role: 'tool',
          tool_call_id: block.call_id,
          // Tool messages DO carry image parts on the wire (empirically
          // verified; the openai-node types excluding them are stale).
          content: formatDataBlocks(block.response) as OpenAI.ChatCompletionContentPartText[],
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
  // Tool messages must directly follow the assistant message whose
  // tool_calls they answer, so they precede any plain user content.
  if (content.length === 0) {
    return tool_messages;
  }
  return [...tool_messages, { role: 'user', content }];
};

const formatAgent = (message: Message, opts: OpenAIFormatOpts): OpenAI.ChatCompletionMessageParam[] => {
  // Content decisions belong to the model's projection profile (shared
  // with every non-wire consumer); this mapper only routes projected
  // blocks into the provider's message shape.
  const refusal: string[] = [];
  const content: string[] = [];
  const thinking: string[] = [];
  const tool_calls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
  for (const block of message.blocks) {
    switch (block.type) {
      case 'data':
        if (!isTextBlock(block)) {
          throw projectionLeak('formatAgent', `data (${block.mime})`);
        }
        content.push(textOf(block));
        break;
      case 'thinking':
        // Present only when the profile kept it (replay_thinking); routed
        // to the structured field, not the text content.
        thinking.push(block.text);
        break;
      case 'refusal':
        refusal.push(block.reason);
        break;
      case 'tool_call':
        // Calls ride in the same assistant message as the reasoning and
        // text that produced them — one turn, one message.
        tool_calls.push({
          id: block.call_id,
          type: 'function',
          function: {
            name: block.tool,
            arguments: JSON.stringify(block.params),
          },
        });
        break;
      default:
        throw projectionLeak('formatAgent', block.type);
    }
  }
  // Thinking wire style: 'field' (default) = DeepSeek-style reasoning_content
  // extension; 'blocks' = Mistral's documented shape, where assistant content
  // is a list of typed chunks and reasoning_content on INPUT is rejected as
  // extra_forbidden. With no thinking to replay, both styles emit the plain
  // string content every provider accepts.
  if (thinking.length && opts.thinking_wire_style === 'blocks') {
    // Tool-call turns cannot carry the thinking chunk: Mistral rejects
    // ThinkChunk content combined with tool_calls (HTTP 400; text-only
    // chunks + tool_calls are accepted). Fall back to the plain string
    // shape for those turns — the trace was already consumed; the text and
    // the calls are what the continuation needs.
    if (tool_calls.length) {
      return [{
        role: 'assistant',
        content: content.length ? content.join(' ') : undefined,
        tool_calls,
      } as OpenAI.ChatCompletionMessageParam];
    }
    const wire_content: Array<Record<string, unknown>> = [];
    wire_content.push({
      type: 'thinking',
      thinking: [{ type: 'text', text: thinking.join('\n') }],
      closed: true,
    });
    if (content.length) {
      wire_content.push({ type: 'text', text: content.join(' ') });
    }
    return [{
      role: 'assistant',
      refusal: refusal.length ? refusal.join(' ') : undefined,
      content: wire_content,
      tool_calls: tool_calls.length ? tool_calls : undefined,
    } as unknown as OpenAI.ChatCompletionMessageParam];
  }
  return [{
    role: 'assistant',
    refusal: refusal.length ? refusal.join(' ') : undefined,
    content: content.length ? content.join(' ') : undefined,
    reasoning_content: thinking.length ? thinking.join(' ') : undefined,
    tool_calls: tool_calls.length ? tool_calls : undefined,
  } as OpenAI.ChatCompletionMessageParam];
};

/** input_audio only accepts wav and mp3. */
const audioFormat = (block: AudioBlock): 'wav' | 'mp3' | undefined => {
  switch (block.mime) {
    case 'audio/wav':
      return 'wav';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    default:
      return undefined;
  }
};

/**
 * Projected data blocks -> provider parts. Content decisions (what
 * survives, how loss is marked) were made upstream by the projection;
 * this mapper only translates surviving blocks into the provider's part
 * types, and hard-crashes on any block it does not support — a violation
 * means the upstream projection was wrong.
 */
export const formatDataBlocks = (blocks: DataBlock[]): UserPart[] => {
  const out: UserPart[] = [];
  for (const block of blocks) {
    if (isTextBlock(block)) {
      out.push({ type: 'text', text: textOf(block) });
    } else if (isImageBlock(block)) {
      // Kept only when the profile allowed it (vision models). The
      // caption rides as its own text part.
      const url = block.data !== undefined
        ? `data:${block.mime};base64,${base64Of(block.data)}`
        : block.url;
      out.push(url
        ? { type: 'image_url', image_url: { url } }
        : { type: 'text', text: `[image unavailable: ${block.mime}]` });
      if (block.caption?.data) {
        out.push({ type: 'text', text: block.caption.data });
      }
    } else if (isAudioBlock(block)) {
      // Kept only when the profile allowed it (audio models). Native
      // audio rides as input_audio; the transcript stays as text — it
      // labels the mediation and keeps fallbacks reading.
      const format = audioFormat(block);
      const attached = block.data !== undefined && format !== undefined;
      if (attached) {
        out.push({ type: 'input_audio', input_audio: { data: base64Of(block.data!), format } });
      }
      const details = [
        block.duration !== undefined ? `${block.duration}s` : undefined,
        attached ? 'audio attached' : 'audio unavailable',
      ].filter(Boolean).join(', ');
      const transcription = block.transcription?.data;
      out.push({
        type: 'text',
        text: transcription
          ? `[audio, ${details}]: ${transcription}`
          : `[audio, ${details}, no transcription]`,
      });
    } else {
      throw projectionLeak('formatDataBlocks', `data (${(block as DataBlock).mime})`);
    }
  }
  return out;
};
