import { ellipsis } from "@loom/utils";
import type { Message } from "./messages.js";
import {
  type Block,
  type DataBlock,
  isAudioBlock,
  isImageBlock,
  isTextBlock,
} from "./blocks/index.js";
import { escapeClosingTag } from "./projection.js";

/**
 * Message serialization: the single rendering layer for projected
 * conversations. Serialization owns HOW CONTENT LOOKS: role naming,
 * block tags, separators, parameter formatting. It never decides what
 * survives — that is projection's job (see ./projection.js).
 *
 * Contract: serialize consumes PROJECTED messages. Blocks the projector
 * would normally have replaced (raw image/audio) appear only when the
 * caller skips projection; the serializer renders them defensively but
 * loudly, never silently.
 */
export interface SerializeOptions {
  /** Joined between consecutive messages by serializeMessages(). */
  message_separator: string;
  /** Human-facing role names; null renders raw roles ('agent'/'user'). */
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

/**
 * Maps call_id -> tool name. Tool responses only carry the call_id; the
 * name lives on the matching tool_call, usually in an earlier message.
 */
export type ToolNames = ReadonlyMap<string, string>;

export const collectToolNames = (messages: readonly Message[]): Map<string, string> => {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_call') {
        names.set(block.call_id, block.tool);
      }
    }
  }
  return names;
};

export const serializeMessages = (messages: Message[], opts: SerializeOptions): string => {
  const tool_names = collectToolNames(messages);
  const joined = messages
    .map(message => serializeMessage(message, opts, tool_names))
    .join(opts.message_separator);
  if (!opts.wrapper_tag) return joined;
  return `<${opts.wrapper_tag}>\n${escapeClosingTag(joined, opts.wrapper_tag)}\n</${opts.wrapper_tag}>`;
};

/**
 * Serialize one message. Pass `tool_names` (see collectToolNames) to
 * render tool responses by tool name; without it, responses whose call
 * is not in the same message fall back to their call_id.
 */
export const serializeMessage = (message: Message, opts: SerializeOptions, tool_names?: ToolNames): string => {
  const role = opts.role_labels === null ? message.role : opts.role_labels[message.role];
  const names = tool_names ?? collectToolNames([message]);
  const body = blocksText(message.blocks, opts, names);
  return body.length > 0 ? `${role}:\n${indent(body, 2)}` : `${role}:`;
};

/** Tag name for block_tags: data blocks are tagged by medium, not by 'data'. */
const tagName = (block: Block): string => {
  if (block.type !== 'data') return block.type;
  if (isTextBlock(block)) return 'text';
  if (isImageBlock(block)) return 'image';
  if (isAudioBlock(block)) return 'audio';
  return 'data';
};

const dataText = (block: DataBlock): string => {
  if (isTextBlock(block)) {
    return block.data ?? (block.url ? `[text: ${block.url}]` : '');
  }
  if (isImageBlock(block)) {
    return `[image block: ${block.mime}]`;
  }
  if (isAudioBlock(block)) {
    const details = [block.mime, block.url, block.duration !== undefined ? `${block.duration}s` : undefined]
      .filter((part): part is string => part !== undefined);
    return `[audio block: ${details.join(', ')}]`;
  }
  // Unknown mime types render loudly; the payload itself is not dumped.
  const { data, ...shape } = block as DataBlock;
  return `[unknown data block: ${JSON.stringify(shape)}]`;
};

const blockText = (block: Block, opts: SerializeOptions, tool_names: ToolNames): string => {
  switch (block.type) {
    case 'data':
      return dataText(block);

    case 'thinking':
    case 'thinking_redacted':
      return block.text || '';

    case 'refusal':
      return block.reason || '';

    case 'tool_call':
      return `${block.tool}: ${paramsText(block.params, opts)}`;

    case 'tool_decl':
      return `[tool declaration: ${block.name}] ${block.description}`;

    case 'tool_resp': {
      const tool = tool_names.get(block.call_id) ?? `call ${block.call_id}`;
      const result = blocksText(block.response, opts, tool_names) || '(empty result)';
      return `${tool} returned:\n${indent(result, 2)}`;
    }

    case 'envelope': {
      const content = blocksText(block.blocks, opts, tool_names);
      const header = `[${block.kind} from ${block.from}]`;
      return content.length > 0 ? `${header}:\n${indent(content, 2)}` : header;
    }

    default:
      // Unknown block types render loudly with their full shape — the
      // structural counterpart of the projector's pass-through default.
      return `[unknown block type: ${JSON.stringify(block)}]`;
  }
};

const blocksText = (blocks: readonly Block[], opts: SerializeOptions, tool_names: ToolNames): string => {
  const rendered: string[] = [];
  for (const block of blocks) {
    const text = blockText(block, opts, tool_names);
    if (text.length > 0) {
      rendered.push(opts.block_tags ? `[${tagName(block)}] ${text}` : text);
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
