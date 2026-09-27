import type Anthropic from '@anthropic-ai/sdk';

import {
  type AgentInput,
  type AgentMessage,
} from "../../../../types/messages.js";
import { type UnsupportedBlock } from "../../../../types/blocks.js";

import { findTextualToolCallNames } from "../openai/parsers.js";

/**
 * One Anthropic response maps to ONE canonical turn: a single AgentInput
 * whose blocks preserve the response's grouping — text/thinking/refusal/
 * unsupported blocks plus one tool_req block per tool_use. The canonical
 * store models the conversation; provider wire quirks live here, in the
 * adapter.
 *
 * Thinking blocks keep their signature (`anthropic_signature`) so a
 * future version of the formatter can replay them for extended
 * thinking; see formatters.ts for why replay is currently stripped.
 */
export const parseMessage = (message: Anthropic.Message): AgentMessage[] => {
  const input: AgentInput = {
    role: 'agent',
    type: 'input',
    blocks: [],
  };
  // Tool requests are blocks WITHIN the turn (see types/messages.ts):
  // the response's grouping — content and tool_use together — is
  // preserved end to end.
  for (const block of message.content ?? []) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) {
          input.blocks.push({ type: 'text', text: block.text });
        }
        break;
      case 'thinking':
        input.blocks.push({
          type: 'thinking',
          text: block.thinking,
          anthropic_signature: block.signature,
        });
        break;
      case 'redacted_thinking':
        input.blocks.push({ type: 'thinking_redacted', text: '' });
        break;
      case 'tool_use':
        input.blocks.push({
          type: 'tool_req',
          req_id: block.id,
          tool: block.name,
          params: block.input as Record<string, unknown>,
        });
        break;
      default:
        // Server-side tool use, web search results, code-execution
        // results, ... — anything this adapter did not request and
        // cannot represent is captured loudly instead of dropped.
        input.blocks.push(asUnsupported(`content block: ${block.type}`, block));
        break;
    }
  }
  return input.blocks.length > 0 ? [input] : [];
};

const asUnsupported = (label: string, payload: unknown): UnsupportedBlock => {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload) ?? 'null';
  } catch {
    serialized = String(payload);
  }
  return { type: 'unsupported', text: `[${label}] ${serialized}` };
};

/**
 * Logs loudly when a response contains NO native tool_use blocks but its
 * text embeds a registered tool name in call-like form — i.e. the model
 * almost certainly tried to call a tool and the call was never executed,
 * its arguments silently lost.
 *
 * Shared implementation with the OpenAI adapter (the failure shapes are
 * provider-agnostic); detection is bounded by the tool REGISTRY, and it
 * is a warning, never an action. See openai/parsers.ts for the incident
 * that guards (2026-09-10 lost distillation write).
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
        `[anthropic-model ${model}] TEXTUAL TOOL CALL — the response carries no native tool_use blocks but its text mentions ` +
        `registered tool(s) [${names.join(', ')}] in call-like form. The intended call was NOT executed and its ` +
        `arguments are lost. Model response text (first 300 chars): ${block.text.slice(0, 300).replace(/\s+/g, ' ')}`,
      );
    }
  }
};

// Re-exported for tests and callers that want the shared detection
// without reaching into the openai adapter module.
export { findTextualToolCallNames };
