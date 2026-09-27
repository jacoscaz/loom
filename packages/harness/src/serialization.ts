import { ellipsis } from "@loom/utils";
import { Message } from "./types/messages.js";
import { MessageBlock } from "./types/blocks.js";
import { escapeClosingTag } from "./projection.js";

/**
 * Message serialization: the single rendering layer for projected
 * conversations. Serialization owns HOW CONTENT LOOKS: role naming,
 * block tags, separators, parameter formatting. It never decides what
 * survives — that is projection's job (see ./projection.js).
 *
 * Contract: serialize consumes PROJECTED messages. Blocks the projector
 * would normally have replaced (raw image/voice) appear only when the
 * caller skips projection; the serializer renders them defensively but
 * loudly, never silently.
 */
export interface SerializeOptions {
  /** Joined between consecutive messages by serializeMessages(). */
  message_separator: string;
  /** Human-facing role names; null renders raw store roles ('agent'/'user'). */
  role_labels: { agent: string; user: string } | null;
  /** Prefix every block with a [type] tag (monologue-style framing). */
  block_tags: boolean;
  /** Pretty-print tool params (multi-line JSON) vs compact JSON. */
  pretty_params: boolean;
  /** Hard bound for rendered tool params, in characters. */
  max_params_length: number;
  /**
   * When set, serializeMessages wraps the whole blob in one XML tag pair
   * (pi's outer-wrapper pattern) and neutralizes occurrences of the
   * closing tag inside the content — a message containing the literal
   * closing tag must not end the wrapped region early. Undefined = no
   * wrapper (framing is the consumer's mechanical separator).
   */
  wrapper_tag?: string;
}

export const SERIALIZE_DISTILLATION_OPTS = {
  message_separator: '\n\n',
  role_labels: null,
  block_tags: false,
  pretty_params: false,
  max_params_length: 2000,
  wrapper_tag: 'undistilled_conversation',
} satisfies SerializeOptions;

export const SERIALIZE_COMPACTION_OPTS = {
  message_separator: '\n\n---\n\n',
  role_labels: { agent: 'Sage', user: 'User' },
  block_tags: false,
  pretty_params: false,
  max_params_length: 2000,
  wrapper_tag: 'conversation',
} satisfies SerializeOptions;

export const SERIALIZE_MONOLOGUE_LOGGING_OPTS = {
  message_separator: '\n\n',
  role_labels: null,
  block_tags: true,
  pretty_params: true,
  max_params_length: 2000,
} satisfies SerializeOptions;

export const serializeMessages = (messages: Message[], opts: SerializeOptions): string => {
  const joined = messages.map(message => serializeMessage(message, opts)).join(opts.message_separator);
  if (!opts.wrapper_tag) return joined;
  return `<${opts.wrapper_tag}>\n${escapeClosingTag(joined, opts.wrapper_tag)}\n</${opts.wrapper_tag}>`;
};

export const serializeMessage = (message: Message, opts: SerializeOptions): string => {
  const role = opts.role_labels === null ? message.role : opts.role_labels[message.role];
  const lines: string[] = [];

  switch (message.type) {
    case 'tool_req':
      lines.push(`${role} requested tool calls:`);
      for (const request of message.requests) {
        lines.push(`  ${request.tool}:`);
        lines.push(indent(paramsText(request.params, opts), 4));
      }
      break;

    case 'tool_res':
      lines.push(`${role} returned tool results:`);
      for (const result of message.results) {
        lines.push(`  ${result.tool}:`);
        lines.push(indent(blocksText(result.blocks, opts) || '(empty result)', 4));
      }
      break;

    case 'notification':
      lines.push(`${role} [${message.method}]:`);
      lines.push(indent(blocksText(message.blocks, opts), 2));
      break;

    case 'input':
      lines.push(`${role}:`);
      lines.push(indent(blocksText(message.blocks, opts), 2));
      break;
  }

  return lines.join('\n');
};

const blocksText = (blocks: MessageBlock[], opts: SerializeOptions): string => {
  const rendered: string[] = [];

  for (const block of blocks) {
    const tag = opts.block_tags ? `[${block.type}] ` : '';
    let text: string;

    switch (block.type) {
      case 'text':
      case 'thinking':
      case 'thinking_redacted':
      case 'refusal':
        text = block.text || '';
        break;

      case 'unsupported':
        // Unknown content is always loudly marked, in every profile —
        // its visibility does not depend on block_tags styling.
        text = `[unsupported] ${block.text || ''}`;
        break;

      case 'image':
        text = `[image block: ${block.mimeType}]`;
        break;

      case 'voice':
        text = `[voice block: ${block.path}, ${block.duration}s]`;
        break;

      case 'tool_req':
        // Tool requests inside a turn render like their legacy message
        // form — same vocabulary, same visibility.
        text = `${block.tool}: ${paramsText(block.params, opts)}`;
        break;

      default:
        // Unknown block types render loudly with their full shape — the
        // structural counterpart of the projector's pass-through default.
        text = `[unknown block type: ${JSON.stringify(block)}]`;
    }

    if (text.length > 0) {
      rendered.push(`${tag}${text}`);
    }
  }

  return rendered.join('\n\n');
};

const paramsText = (params: unknown, opts: SerializeOptions): string => {
  let text: string;
  try {
    text = opts.pretty_params
      ? JSON.stringify(params, null, 2) ?? 'null'
      : JSON.stringify(params) ?? 'null';
  } catch {
    text = String(params);
  }
  return ellipsis(text, opts.max_params_length);
};

const indent = (text: string, spaces: number): string => {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map(line => line.length > 0 ? pad + line : line).join('\n');
};
