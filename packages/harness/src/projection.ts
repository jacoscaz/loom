import { Message, UserBlock } from "./types/messages.js";
import { MessageBlock, TextBlock, VoiceBlock } from "./types/blocks.js";

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
 * once per profile. A consumer that silently loses content is now a
 * visible diff in its profile object, not an inline `continue`.
 */
export interface ProjectOptions {
  /** Text (and refusal/unsupported) blocks longer than this are truncated. */
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
  /** Drop tool_req/tool_res messages entirely. */
  exclude_tool_traffic: boolean;
  /**
   * How media blocks are represented. Per-medium, not uniform: image and
   * voice differ in what every audience can do with them (a visual-model
   * wire keeps images; an audio-capable openai-style wire keeps voice as
   * native input_audio — since 2026-09-26).
   * - 'keep': pass through untouched (visual model wire, mirrors);
   * - 'placeholder': replace with a visible text marker;
   * - 'omit': drop entirely.
   */
  image_policy: 'keep' | 'placeholder' | 'omit';
  voice_policy: 'keep' | 'placeholder' | 'omit';
  /**
   * How many data-carrying voice blocks may ride as native audio per
   * prompt, in conversation order (most recent kept). Providers cap
   * input_audio parts (DeepInfra/MiMo: 2 — hit live 2026-09-26 when a
   * third voice note entered one session's history and the provider
   * rejected the whole request). The transcript is the guaranteed
   * channel; sound is additive. Voice blocks beyond the window convert
   * to their transcription with an 'audio aged out' marker — distinct
   * from the placeholder path ('omitted') because the causes differ.
   * Undefined = unlimited. Consulted only under voice_policy 'keep'
   * (placeholder/omit never let audio ride).
   */
  audio_window?: number;
}

export const PROJECT_DISTILLATION_OPTS = {
  max_text_length: 2000,
  exclude_thinking: true,
  thinking_redacted_policy: 'omit',
  exclude_tool_traffic: true,
  // Visible markers over silent omission — the survey showed labeled
  // placeholders are the norm (opencode, pi), and silence was the old
  // defect class this layer exists to end.
  image_policy: 'placeholder',
  voice_policy: 'placeholder',
} satisfies ProjectOptions;

export const PROJECT_COMPACTION_OPTS = {
  max_text_length: 2000,
  exclude_thinking: true,
  thinking_redacted_policy: 'omit',
  exclude_tool_traffic: false,
  image_policy: 'placeholder',
  voice_policy: 'placeholder',
} satisfies ProjectOptions;

export const PROJECT_MONOLOGUE_LOGGING_OPTS = {
  max_text_length: 2000,
  exclude_thinking: false,
  thinking_redacted_policy: 'keep',
  exclude_tool_traffic: false,
  image_policy: 'placeholder',
  voice_policy: 'placeholder',
} satisfies ProjectOptions;

/**
 * Project a whole conversation. Messages dropped by policy (tool traffic
 * under exclude_tool_traffic) are removed here, so downstream consumers
 * never see holes — they see the projected conversation.
 */
/**
 * Voice becomes its transcript when native audio does not ride. The
 * cause is declared in the marker: 'omitted' (policy: this audience
 * never gets audio) vs 'aged-out' (audio existed, but the per-prompt
 * audio window released it). Same rule as everywhere in this layer —
 * visible, labelled loss over silent loss.
 */
const voiceToText = (block: VoiceBlock, opts: ProjectOptions, cause: 'omitted' | 'aged-out'): TextBlock => {
  if (block.transcription) {
    const marker = cause === 'aged-out' ? ', audio aged out' : '';
    return { type: 'text', text: truncate(`[voice note transcript, ${block.duration}s${marker}]: ${block.transcription}`, opts.max_text_length) };
  }
  return { type: 'text', text: cause === 'aged-out'
    ? `[voice note aged out: ${block.path}, ${block.duration}s]`
    : `[voice note omitted: ${block.path}, ${block.duration}s]` };
};

const isCarryingVoice = (b: UserBlock): b is VoiceBlock => b.type === 'voice' && !!b.data;

/**
 * The audio window (opts.audio_window, consulted only under
 * voice_policy 'keep'): at most N data-carrying voice blocks per
 * conversation may ride as native audio — providers cap input_audio
 * parts per prompt. Older blocks convert to their transcription, so
 * what survives the projection is complete either way: recent notes as
 * sound + transcript, older notes as transcript with the cause marked.
 */
const applyAudioWindow = (messages: Message[], opts: ProjectOptions): Message[] => {
  if (opts.voice_policy !== 'keep') return messages;
  const limit = opts.audio_window ?? Number.POSITIVE_INFINITY;
  const carrying: VoiceBlock[] = [];
  for (const m of messages) {
    if (m.role !== 'user') continue;
    if (m.type === 'input' || m.type === 'notification') carrying.push(...m.blocks.filter(isCarryingVoice));
    else if (m.type === 'tool_res') for (const r of m.results) carrying.push(...r.blocks.filter(isCarryingVoice));
  }
  if (carrying.length <= limit) return messages;
  const evicted = new Set(carrying.slice(0, carrying.length - limit));
  const release = (b: UserBlock): UserBlock =>
    evicted.has(b as VoiceBlock) ? voiceToText(b as VoiceBlock, opts, 'aged-out') : b;
  return messages.map((m): Message => {
    if (m.role !== 'user') return m;
    if (m.type === 'input' || m.type === 'notification') return { ...m, blocks: m.blocks.map(release) };
    if (m.type === 'tool_res') return { ...m, results: m.results.map(r => ({ ...r, blocks: r.blocks.map(release) })) };
    return m;
  });
};

export const projectMessages = (messages: Message[], opts: ProjectOptions): Message[] => {
  return applyAudioWindow(
    messages
      .map(message => projectMessage(message, opts))
      .filter((message): message is Message => message !== null),
    opts,
  );
};

/**
 * Project one message. Returns null when the whole message is dropped by
 * policy (tool traffic under exclude_tool_traffic); consumers rendering
 * single messages (monologue logger) must handle null.
 */
export const projectMessage = (message: Message, opts: ProjectOptions): Message | null => {
  if (opts.exclude_tool_traffic && (message.type === 'tool_req' || message.type === 'tool_res')) {
    return null;
  }

  switch (message.type) {
    case 'tool_req':
      // Params are projection-opaque: bounded at serialization time.
      return message;

    case 'tool_res':
      return {
        ...message,
        results: message.results.map(result => ({
          ...result,
          blocks: projectBlocks(result.blocks, opts),
        })),
      };

    case 'notification':
      return {
        ...message,
        blocks: projectBlocks(message.blocks, opts),
      };

    case 'input':
      // Narrow by role so each branch's block family matches its message type.
      if (message.role === 'agent') {
        return { ...message, blocks: projectBlocks(message.blocks, opts) };
      }
      return { ...message, blocks: projectBlocks(message.blocks, opts) };
  }
};

/**
 * Projection outputs are always within the input block family's space:
 * pass-through keeps the original block, and every replacement is a
 * TextBlock (a member of both UserBlock and AgentBlock). The internal
 * cast below only bridges the generic parameter, not the type space.
 */
export const projectBlocks = <B extends MessageBlock>(blocks: readonly B[], opts: ProjectOptions): B[] => {
  const projected: B[] = [];
  for (const block of blocks) {
    const mapped = projectBlock(block as MessageBlock, opts);
    if (mapped !== null) projected.push(mapped as B);
  }
  return projected;
};

const projectBlock = (block: MessageBlock, opts: ProjectOptions): MessageBlock | null => {
  switch (block.type) {
    case 'text':
      return { ...block, text: truncate(block.text || '', opts.max_text_length) };

    case 'refusal':
      return { ...block, text: truncate(block.text || '', opts.max_text_length) };

    case 'thinking':
      return opts.exclude_thinking ? null : block;

    case 'thinking_redacted':
      if (opts.thinking_redacted_policy === 'omit') return null;
      if (opts.thinking_redacted_policy === 'placeholder') {
        // No replayable content, but the place is declared so the history
        // stays visibly complete.
        return { type: 'text', text: '[thinking redacted]' };
      }
      return block;

    case 'image':
      if (opts.image_policy === 'omit') return null;
      if (opts.image_policy === 'keep') return block;
      // The caption is content: it survives with the marker (a caption
      // dropped silently would be the exact defect class this layer ends).
      return { type: 'text', text: block.caption ? `[image omitted: ${block.mimeType}] ${block.caption}` : `[image omitted: ${block.mimeType}]` };

    case 'voice':
      if (opts.voice_policy === 'omit') return null;
      if (opts.voice_policy === 'keep') return block;
      // A transcription is content: when present it survives as text,
      // wrapped in a provenance marker — the reader must be able to tell
      // a spoken note from a typed message, and the no-transcription
      // placeholder above already declares the convention.
      return voiceToText(block, opts, 'omitted');

    case 'unsupported':
      // Unknown content always survives, loudly, in every profile.
      return block;

    case 'tool_req':
      // Tool requests survive as blocks unless tool traffic is excluded —
      // the block-level form of the message-level policy above: the turn's
      // text is kept, its calls dropped.
      return opts.exclude_tool_traffic ? null : block;

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
