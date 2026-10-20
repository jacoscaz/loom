import type { Message } from "./messages.js";
import {
  type AudioBlock,
  type Block,
  type DataBlock,
  type TextBlock,
  isAudioBlock,
  isImageBlock,
  isTextBlock,
} from "./blocks/index.js";

/**
 * Message projection: the single content-decision layer shared by every
 * consumer that renders the conversation for a non-wire audience
 * (monologue mirror, compactor, distiller).
 *
 * Projection owns WHAT SURVIVES: which blocks and messages a consumer
 * sees, how oversized text and non-text media are represented. It never
 * formats: rendering is serialization's job (see ./serialization.js).
 *
 * Every decision is a declared field of ProjectOptions, instantiated
 * once per profile. A consumer that silently loses content is a visible
 * diff in its profile object, not an inline `continue`.
 */
export interface ProjectOptions {
  /** Text data blocks and refusal reasons longer than this are truncated. */
  max_text_length: number;
  /** Drop thinking blocks entirely (the reasoning itself). */
  exclude_thinking: boolean;
  /**
   * Redacted reasoning carries no replayable content, but its PLACE may
   * matter: adapters mark the hole ('placeholder') so the replayed history
   * stays visibly complete; readers omit ('omit') or keep the raw block
   * ('keep') according to their profile.
   */
  thinking_redacted_policy: 'omit' | 'placeholder' | 'keep';
  /** Drop tool_call and tool_resp blocks entirely. */
  exclude_tool_traffic: boolean;
  /**
   * How media data blocks are represented. Per-medium, not uniform: image
   * and audio differ in what every audience can do with them (a visual-model
   * wire keeps images; an audio-capable wire keeps audio as native input).
   * - 'keep': pass through untouched (visual model wire, mirrors);
   * - 'placeholder': replace with a visible text marker;
   * - 'omit': drop entirely.
   */
  image_policy: 'keep' | 'placeholder' | 'omit';
  audio_policy: 'keep' | 'placeholder' | 'omit';
  /**
   * How many data-carrying audio blocks may ride as native audio per
   * prompt, in conversation order (most recent kept). Providers cap
   * audio input parts (DeepInfra/MiMo: 2). The transcript is the
   * guaranteed channel; sound is additive. Audio blocks beyond the window
   * convert to their transcription with an 'audio aged out' marker —
   * distinct from the placeholder path ('omitted') because the causes
   * differ. Undefined = unlimited. Consulted only under audio_policy
   * 'keep' (placeholder/omit never let audio ride).
   */
  audio_window?: number;
}

export const PROJECT_DISTILLATION_OPTS = {
  max_text_length: 2000,
  exclude_thinking: true,
  thinking_redacted_policy: 'omit',
  exclude_tool_traffic: true,
  // Visible markers over silent omission — labeled placeholders are the
  // norm (opencode, pi), and silence was the old defect class this layer
  // exists to end.
  image_policy: 'placeholder',
  audio_policy: 'placeholder',
} satisfies ProjectOptions;

export const PROJECT_COMPACTION_OPTS = {
  max_text_length: 2000,
  exclude_thinking: true,
  thinking_redacted_policy: 'omit',
  exclude_tool_traffic: false,
  image_policy: 'placeholder',
  audio_policy: 'placeholder',
} satisfies ProjectOptions;

export const PROJECT_MONOLOGUE_LOGGING_OPTS = {
  max_text_length: 2000,
  exclude_thinking: false,
  thinking_redacted_policy: 'keep',
  exclude_tool_traffic: false,
  image_policy: 'placeholder',
  audio_policy: 'placeholder',
} satisfies ProjectOptions;

const text = (data: string): TextBlock => ({ type: 'data', mime: 'text/plain', data });

/** Human-readable origin of an audio block, e.g. "file:///v.ogg, 12s". */
const describeAudio = (block: AudioBlock): string => {
  return [block.url, block.duration !== undefined ? `${block.duration}s` : undefined]
    .filter((part): part is string => part !== undefined)
    .join(', ');
};

/**
 * Audio becomes its transcript when native audio does not ride. The
 * cause is declared in the marker: 'omitted' (policy: this audience
 * never gets audio) vs 'aged-out' (audio existed, but the per-prompt
 * audio window released it). Same rule as everywhere in this layer —
 * visible, labelled loss over silent loss.
 */
const audioToText = (block: AudioBlock, opts: ProjectOptions, cause: 'omitted' | 'aged-out'): TextBlock => {
  const description = describeAudio(block);
  const transcription = block.transcription?.data;
  if (transcription) {
    const details = [description, cause === 'aged-out' ? 'audio aged out' : undefined]
      .filter((part) => !!part)
      .join(', ');
    const label = details ? `[audio transcript, ${details}]` : '[audio transcript]';
    return text(truncate(`${label}: ${transcription}`, opts.max_text_length));
  }
  const label = cause === 'aged-out' ? 'audio aged out' : 'audio omitted';
  return text(description ? `[${label}: ${description}]` : `[${label}]`);
};

const isCarryingAudio = (block: DataBlock): block is AudioBlock => {
  return isAudioBlock(block) && block.data !== undefined;
};

/** Data blocks a user message carries, including those nested in tool responses and envelopes. */
const userDataBlocks = (message: Message): DataBlock[] => {
  return message.blocks.flatMap((block): DataBlock[] => {
    switch (block.type) {
      case 'data': return [block];
      case 'tool_resp': return block.response;
      case 'envelope': return block.blocks;
      default: return [];
    }
  });
};

const mapDataBlocks = (message: Message, fn: (block: DataBlock) => DataBlock): Message => ({
  ...message,
  blocks: message.blocks.map((block): Block => {
    switch (block.type) {
      case 'data': return fn(block);
      case 'tool_resp': return { ...block, response: block.response.map(fn) };
      case 'envelope': return { ...block, blocks: block.blocks.map(fn) };
      default: return block;
    }
  }),
});

/**
 * The audio window (opts.audio_window, consulted only under
 * audio_policy 'keep'): at most N data-carrying audio blocks per
 * conversation may ride as native audio — providers cap audio input
 * parts per prompt. Older blocks convert to their transcription, so
 * what survives the projection is complete either way: recent notes as
 * sound + transcript, older notes as transcript with the cause marked.
 */
const applyAudioWindow = (messages: Message[], opts: ProjectOptions): Message[] => {
  if (opts.audio_policy !== 'keep') return messages;
  const limit = opts.audio_window ?? Number.POSITIVE_INFINITY;
  const carrying = messages
    .filter((m) => m.role === 'user')
    .flatMap(userDataBlocks)
    .filter(isCarryingAudio);
  if (carrying.length <= limit) return messages;
  const evicted = new Set<DataBlock>(carrying.slice(0, carrying.length - limit));
  const release = (block: DataBlock): DataBlock =>
    evicted.has(block) ? audioToText(block as AudioBlock, opts, 'aged-out') : block;
  return messages.map((m) => m.role === 'user' ? mapDataBlocks(m, release) : m);
};

/**
 * Project a whole conversation. Messages left without blocks (e.g. a
 * message carrying only tool traffic under exclude_tool_traffic) are
 * removed here, so downstream consumers never see holes — they see the
 * projected conversation.
 */
export const projectMessages = (messages: Message[], opts: ProjectOptions): Message[] => {
  return applyAudioWindow(
    messages
      .map(message => projectMessage(message, opts))
      .filter((message): message is Message => message !== null),
    opts,
  );
};

/**
 * Project one message. Returns null when policy removes every block of
 * the message; consumers rendering single messages (monologue logger)
 * must handle null.
 */
export const projectMessage = (message: Message, opts: ProjectOptions): Message | null => {
  const blocks = projectBlocks(message.blocks, opts);
  if (blocks.length === 0 && message.blocks.length > 0) {
    return null;
  }
  return { ...message, blocks };
};

export const projectBlocks = (blocks: readonly Block[], opts: ProjectOptions): Block[] => {
  const projected: Block[] = [];
  for (const block of blocks) {
    const mapped = projectBlock(block, opts);
    if (mapped !== null) projected.push(mapped);
  }
  return projected;
};

/**
 * Data block projection is closed over DataBlock: pass-through keeps the
 * original block, every replacement is a text data block. This lets
 * nested data (tool responses, envelopes) project in place.
 */
export const projectDataBlocks = (blocks: readonly DataBlock[], opts: ProjectOptions): DataBlock[] => {
  const projected: DataBlock[] = [];
  for (const block of blocks) {
    const mapped = projectDataBlock(block, opts);
    if (mapped !== null) projected.push(mapped);
  }
  return projected;
};

const projectDataBlock = (block: DataBlock, opts: ProjectOptions): DataBlock | null => {
  if (isTextBlock(block)) {
    if (block.data === undefined) return block;
    return { ...block, data: truncate(block.data, opts.max_text_length) };
  }

  if (isImageBlock(block)) {
    if (opts.image_policy === 'omit') return null;
    if (opts.image_policy === 'keep') return block;
    // The caption is content: it survives with the marker (a caption
    // dropped silently would be the exact defect class this layer ends).
    const caption = block.caption?.data;
    return text(caption ? `[image omitted: ${block.mime}] ${caption}` : `[image omitted: ${block.mime}]`);
  }

  if (isAudioBlock(block)) {
    if (opts.audio_policy === 'omit') return null;
    if (opts.audio_policy === 'keep') return block;
    // A transcription is content: when present it survives as text,
    // wrapped in a provenance marker — the reader must be able to tell
    // a spoken note from a typed message.
    return audioToText(block, opts, 'omitted');
  }

  // Data with an unknown mime type passes through untouched; the
  // serializer renders it visibly.
  return block;
};

const projectBlock = (block: Block, opts: ProjectOptions): Block | null => {
  switch (block.type) {
    case 'data':
      return projectDataBlock(block, opts);

    case 'refusal':
      return { ...block, reason: truncate(block.reason, opts.max_text_length) };

    case 'thinking':
      return opts.exclude_thinking ? null : block;

    case 'thinking_redacted':
      if (opts.thinking_redacted_policy === 'omit') return null;
      if (opts.thinking_redacted_policy === 'placeholder') {
        // No replayable content, but the place is declared so the history
        // stays visibly complete.
        return text('[thinking redacted]');
      }
      return block;

    case 'tool_call':
      // Params are projection-opaque: bounded at serialization time.
      return opts.exclude_tool_traffic ? null : block;

    case 'tool_resp':
      if (opts.exclude_tool_traffic) return null;
      return { ...block, response: projectDataBlocks(block.response, opts) };

    case 'envelope':
      return { ...block, blocks: projectDataBlocks(block.blocks, opts) };

    default:
      // Block types the projection layer does not know about pass through
      // untouched; the serializer renders them visibly. Silent loss needs
      // a declared policy field; there is none for this case, by design.
      return block;
  }
};

const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[...truncated ${text.length - max} characters]`;
};

/**
 * Neutralize the closing tag of a wrapper BEFORE the wrapper is applied.
 * Content containing the literal closing tag would otherwise end the
 * wrapped region early from the reader's point of view — tag forgery.
 * Occurrences are escaped (<\/tag>): still readable as what they were,
 * no longer a boundary.
 *
 * Applied consumer-side over the FULL serialized blob (block text and
 * tool params alike), because projection deliberately leaves params
 * untouched and the wrapper tag is chosen by the consumer's template.
 */
export const escapeClosingTag = (text: string, tag: string): string => {
  return text.replaceAll(`</${tag}>`, `<\\/${tag}>`);
};
