import type OpenAI from 'openai';
import type { Block, Message } from "@loom/proto";
import { textBlock, unsupportedBlock } from "../shared.js";

/**
 * Mistral ThinkChunk shape: `thinking` is either a list of TextChunks
 * (documented form) or, defensively, a plain string (some providers flatten).
 */
const thinkingTraceText = (thinking: unknown): string => {
  if (Array.isArray(thinking)) {
    return (thinking as unknown[])
      .map(t => (typeof (t as Record<string, unknown>)?.text === 'string' ? (t as Record<string, unknown>).text as string : ''))
      .filter(Boolean)
      .join('\n');
  }
  return typeof thinking === 'string' ? thinking : '';
};

/**
 * Sometimes models return invalid JSON for function call arguments.
 *
 * Examples seen in production:
 * - DeepSeek V4 Pro (Tensorix) returned `{}""` for no params
 */
const parseFunctionCallArgs = (call: OpenAI.ChatCompletionMessageFunctionToolCall): Record<string, unknown> => {
  try {
    return JSON.parse(call.function.arguments);
  } catch {
    return {};
  }
};

/**
 * One provider response maps to ONE agent message whose blocks preserve
 * the response's grouping (content + tool_calls together, etc.).
 * Thinking/reasoning content is captured as a thinking block for
 * continuity purposes; whether it is replayed to the provider is decided
 * by the model's projection (replay_thinking).
 */
export const parseMessage = (message: OpenAI.ChatCompletionMessage): Message[] => {
  const blocks: Block[] = [];
  // Standard OpenAI responses carry content as a string. Mistral's reasoning
  // models (documented deviation, docs.mistral.ai capabilities/reasoning)
  // return `content` as a LIST of typed chunks instead — ThinkChunk
  // (`type: "thinking"`, `thinking` itself a list of TextChunks) and
  // TextChunk (`type: "text"`). Normalize here so the message shape is
  // provider-independent: thinking chunks become thinking blocks, text
  // chunks concatenate into one text block, unknown chunk types are
  // captured as unsupported rather than dropped.
  if (typeof message.content === 'string') {
    blocks.push(textBlock(message.content));
  } else if (Array.isArray(message.content)) {
    // The SDK types content as `string | null`, so Array.isArray narrows it
    // to never — retype explicitly; the real payload is provider-defined.
    const content_chunks = message.content as unknown[];
    const texts: string[] = [];
    for (const chunk of content_chunks) {
      const c = chunk as Record<string, unknown>;
      if (c?.type === 'text' && typeof c.text === 'string') {
        texts.push(c.text);
      } else if (c?.type === 'thinking') {
        const trace = thinkingTraceText(c.thinking);
        if (trace) {
          blocks.push({ type: 'thinking', text: trace });
        }
      } else {
        blocks.push(unsupportedBlock('content chunk', chunk));
      }
    }
    if (texts.length > 0) {
      blocks.push(textBlock(texts.join('')));
    }
  }
  if ('reasoning_content' in message && typeof message.reasoning_content === 'string') {
    blocks.push({ type: 'thinking', text: message.reasoning_content });
  }
  if (message.refusal) {
    blocks.push({ type: 'refusal', reason: message.refusal });
  }
  if (message.tool_calls) {
    for (const call of message.tool_calls) {
      if (call.type === 'function') {
        blocks.push({
          type: 'tool_call',
          call_id: call.id,
          tool: call.function.name,
          params: parseFunctionCallArgs(call),
        });
      } else {
        blocks.push(unsupportedBlock(`tool call: ${call.type}`, call));
      }
    }
  }
  // Anything the response carries that this adapter cannot represent
  // natively is captured as an unsupported block instead of dropped.
  if ('function_call' in message && message.function_call) {
    blocks.push(unsupportedBlock('legacy function_call', message.function_call));
  }
  if (message.annotations && message.annotations.length > 0) {
    blocks.push(unsupportedBlock('annotations', message.annotations));
  }
  return blocks.length > 0 ? [{ role: 'agent', blocks }] : [];
};
