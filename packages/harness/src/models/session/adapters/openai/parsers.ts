
import OpenAI from 'openai';

import {
  type AgentInput,
  type AgentMessage,
} from "../../../../types/messages.js";
import { type UnsupportedBlock } from "../../../../types/blocks.js";

/**
  * One provider response maps to ONE canonical message whose `blocks` array
  * preserves the response's grouping (content + tool_calls together, etc.).
  * Thinking/reasoning content is captured as a thinking block for continuity
  * purposes; whether it is replayed to the provider is decided per-model at
  * format time (see OpenAISessionModel#replay_thinking).
  */
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

export const parseMessage = (message: OpenAI.ChatCompletionMessage): AgentMessage[] => {
  const input: AgentInput = {
    role: 'agent',
    type: 'input',
    blocks: [],
  };
  // Tool requests are blocks WITHIN the turn (see types/messages.ts):
  // the response's grouping — content and tool_calls together — is
  // preserved end to end.
  // Standard OpenAI responses carry content as a string. Mistral's reasoning
  // models (documented deviation, docs.mistral.ai capabilities/reasoning)
  // return `content` as a LIST of typed chunks instead — ThinkChunk
  // (`type: "thinking"`, `thinking` itself a list of TextChunks) and
  // TextChunk (`type: "text"`). Normalize here so the canonical message
  // shape is provider-independent: thinking chunks become thinking blocks,
  // text chunks concatenate into one text block, unknown chunk types are
  // captured as unsupported rather than dropped.
  if (typeof message.content === 'string') {
    input.blocks.push({
      type: 'text',
      text: message.content,
    });
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
          input.blocks.push({ type: 'thinking', text: trace });
        }
      } else {
        input.blocks.push(asUnsupported('content chunk', chunk));
      }
    }
    if (texts.length > 0) {
      input.blocks.push({ type: 'text', text: texts.join('') });
    }
  }
  if ('reasoning_content' in message && typeof message.reasoning_content === 'string') {
    input.blocks.push({
      type: 'thinking',
      text: message.reasoning_content,
    });
  }
  if (message.refusal) {
    input.blocks.push({
      type: 'text',
      text: message.refusal,
    });
  }
  if (message.tool_calls) {
    for (const call of message.tool_calls) {
      if (call.type === 'function') {
        const params = parseFunctionCallArgs(call);
        input.blocks.push({
          type: 'tool_req',
          req_id: call.id,
          tool: call.function.name,
          params,
        });
      }
    }
  }
  // Anything the response carries that this adapter cannot represent
  // natively is captured as an unsupported block instead of dropped:
  // continuity keeps it, and every downstream renderer shows it loudly.
  if ('function_call' in message && message.function_call) {
    input.blocks.push(asUnsupported('legacy function_call', message.function_call));
  }
  if (message.annotations && message.annotations.length > 0) {
    input.blocks.push(asUnsupported('annotations', message.annotations));
  }
  return input.blocks.length > 0 ? [input] : [];
};

/**
 * Sometimes model return invalid JSON for function call arguments.
 *
 * Examples seen while using this harness:
 * - DeepSeek V4 Pro (Tensorix) returned `{}""` for no params
 */
const asUnsupported = (label: string, payload: unknown): UnsupportedBlock => {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload) ?? 'null';
  } catch {
    serialized = String(payload);
  }
  return { type: 'unsupported', text: `[${label}] ${serialized}` };
};

const parseFunctionCallArgs = (call: OpenAI.ChatCompletionMessageFunctionToolCall): Record <string, unknown> => {
  try {
    return JSON.parse(call.function.arguments);
  } catch {
    return {};
  }
};

/**
  * Matches the wire shapes in which models most commonly emit tool calls as
  * plain text instead of using the native tool-calling mechanism:
  * - `<tool_name ...` — XML-ish open tag (observed: DeepSeek V4.1 Flash,
  *   2026-09-10, emitting `<continuity_append<arg_key>id</arg_key><arg_value>2701` in the distiller);
  * - `tool_name<arg_key>` — arg-key marker style;
  * - `"name": "tool_name"` — JSON-shaped call.
  *
  * Bounded by the tool REGISTRY, not by failure-shape heuristics: we only
  * look for names the harness itself registered, in call-like forms. A
  * mention of a tool name in running prose does not match any of these.
  * False positives are possible (e.g. a model documenting its own tools)
  * and acceptable: this is a warning, never an action.
  */
const TEXTUAL_TOOL_CALL_PATTERNS = (toolName: string): RegExp[] => [
  new RegExp(`<${toolName}(?![a-zA-Z0-9_-])`),
  new RegExp(`${toolName}<arg_key>`),
  new RegExp(`["']name["']\\s*:\\s*["']${toolName}["']`),
];

export const findTextualToolCallNames = (text: string, toolNames: string[]): string[] => {
  const found: string[] = [];
  for (const name of toolNames) {
    if (TEXTUAL_TOOL_CALL_PATTERNS(name).some((pattern) => pattern.test(text))) {
      found.push(name);
    }
  }
  return found;
};

/**
  * Logs loudly when a response contains NO native tool_calls but its text
  * embeds a registered tool name in call-like form — i.e. the model almost
  * certainly tried to call a tool and the call was never executed, its
  * arguments silently lost.
  *
  * This guards a real incident (2026-09-10): the distiller session emitted
  * `<continuity_append<arg_key>id</arg_key><arg_value>2701...` as a text block, the harness stored
  * it as prose, nothing executed, and a distillation write was lost with
  * no error and no trace. Silence, not failure, was the defect.
  *
  * Detection is deliberately skipped when the response DOES carry native
  * tool_calls: a text block mentioning a tool name alongside real calls is
  * commentary, not a lost call.
  */
export const warnOnTextualToolCalls = (messages: AgentMessage[], toolNames: string[], model: string): void => {
  if (toolNames.length === 0) return;
  if (messages.some((m) => m.type === 'tool_req')) return;
  for (const message of messages) {
    if (message.type !== 'input') continue;
    for (const block of message.blocks) {
      if (block.type !== 'text') continue;
      const names = findTextualToolCallNames(block.text, toolNames);
      if (names.length === 0) continue;
      console.error(
        `[openai-model ${model}] TEXTUAL TOOL CALL — the response carries no native tool_calls but its text mentions ` +
        `registered tool(s) [${names.join(', ')}] in call-like form. The intended call was NOT executed and its ` +
        `arguments are lost. Model response text (first 300 chars): ${block.text.slice(0, 300).replace(/\s+/g, ' ')}`,
      );
    }
  }
};
