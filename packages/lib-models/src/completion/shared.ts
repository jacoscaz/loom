import type { EnvelopeBlock, Message, TextBlock } from "@loom/proto";

/**
 * Helpers shared by every completion adapter: wire-independent renderings
 * and response-side safety checks.
 */

export const textBlock = (data: string): TextBlock => ({ type: 'data', mime: 'text/plain', data });

/** Text content of a text block; url-only blocks render their reference. */
export const textOf = (block: TextBlock): string => {
  return block.data ?? (block.url ? `[text: ${block.url}]` : '');
};

/**
 * Binary payloads are typed as Buffers, but history deserialized from
 * JSON may carry them as base64 strings already.
 */
export const base64Of = (data: Buffer | string): string => {
  return typeof data === 'string' ? data : data.toString('base64');
};

/** The ONE wire rendering of an envelope's provenance. */
export const envelopeHeader = (block: EnvelopeBlock): string => {
  return `[${block.kind} from ${block.from}]`;
};

/**
 * Response content an adapter cannot represent natively is captured as a
 * loudly marked text block instead of being dropped: the conversation
 * keeps it, and every downstream renderer shows it.
 */
export const unsupportedBlock = (label: string, payload: unknown): TextBlock => {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload) ?? 'null';
  } catch {
    serialized = String(payload);
  }
  return textBlock(`[unsupported] [${label}] ${serialized}`);
};

/** Thrown by formatters when projection let through a block they cannot represent. */
export const projectionLeak = (where: string, type: string): Error => {
  return new Error(`${where}: unsupported block type '${type}' — upstream projection leaked a block the formatter cannot represent`);
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
 * look for names the caller itself registered, in call-like forms. A
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
 * Logs loudly when a response contains NO native tool calls but its text
 * embeds a registered tool name in call-like form — i.e. the model almost
 * certainly tried to call a tool and the call was never executed, its
 * arguments silently lost.
 *
 * This guards a real incident (2026-09-10): the distiller session emitted
 * `<continuity_append<arg_key>id</arg_key><arg_value>2701...` as a text
 * block, the harness stored it as prose, nothing executed, and a
 * distillation write was lost with no error and no trace. Silence, not
 * failure, was the defect.
 *
 * Detection is deliberately skipped when the response DOES carry native
 * tool calls: a text block mentioning a tool name alongside real calls is
 * commentary, not a lost call.
 */
export const warnOnTextualToolCalls = (messages: Message[], toolNames: string[], label: string): void => {
  if (toolNames.length === 0) return;
  const blocks = messages.flatMap((m) => m.blocks);
  if (blocks.some((b) => b.type === 'tool_call')) return;
  for (const block of blocks) {
    if (block.type !== 'data' || block.mime !== 'text/plain' || !block.data) continue;
    const names = findTextualToolCallNames(block.data, toolNames);
    if (names.length === 0) continue;
    console.error(
      `[${label}] TEXTUAL TOOL CALL — the response carries no native tool calls but its text mentions ` +
      `registered tool(s) [${names.join(', ')}] in call-like form. The intended call was NOT executed and its ` +
      `arguments are lost. Model response text (first 300 chars): ${block.data.slice(0, 300).replace(/\s+/g, ' ')}`,
    );
  }
};
