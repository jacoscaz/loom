
import type { AudioBlock, DataBlock, ImageBlock, MessageEnvelopeBlock } from "@loom/proto";
import type { Logger } from "pinetto";
import { type TelegramClient } from "./client.js";
import { type TelegramUpdate } from "./types/message.js";

/** Minimal logger surface used by this module (satisfied by pinetto). */
export type TelegramLogger = Pick<Logger, 'error' | 'warn' | 'info'>;

const errMessage = (err: unknown): string => err instanceof Error ? err.message : String(err);

/** Telegram user URL, used as the envelope's `from`. */
export const userUrl = (user_id: number): string => `telegram:${user_id}`;

/** Telegram chat URL, used as the envelope's `session`. */
export const chatSession = (chat_id: number): string => `telegram:${chat_id}`;

/**
 * Detects the image MIME type from magic bytes. Returns `undefined` for
 * formats that `ImageBlock` cannot carry.
 */
export const detectImageMime = (bytes: Buffer): ImageBlock['mime'] | undefined => {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
};

/**
 * Turns one Telegram update into a message envelope for the harness, or
 * `null` when the update carries nothing that should be forwarded.
 *
 * Media is fetched and inlined as raw bytes. Voice notes go out as
 * `audio/ogg` blocks without a transcription: transcription is the
 * harness' job. Download failures are logged and the affected block is
 * omitted; the rest of the message still goes through.
 */
export const updateToEnvelope = async (
  client: TelegramClient,
  log: TelegramLogger,
  update: TelegramUpdate,
  allowed_user_ids?: number[],
): Promise<MessageEnvelopeBlock | null> => {
  const message = update.message;
  if (!message) {
    // For now we do not support updates about things other than messages.
    // This includes edited messages, see `update.edited_message` property.
    return null;
  }
  const from = message.from;
  if (!from) {
    // We do not support updates with no sender information due to the
    // security risk they pose.
    return null;
  }
  if (allowed_user_ids && !allowed_user_ids.includes(from.id)) {
    log.warn('dropping update %s from non-allowlisted user %s', update.update_id, from.id);
    return null;
  }

  const blocks: DataBlock[] = [];

  if (message.voice) {
    try {
      const data = await client.fetchFile(message.voice.file_id);
      const block: AudioBlock = {
        type: 'data',
        mime: 'audio/ogg',
        data,
        duration: message.voice.duration,
      };
      blocks.push(block);
    } catch (err) {
      log.error('voice note download failed: %s', errMessage(err));
    }
  }

  if (message.photo && message.photo.length > 0) {
    // Telegram sends photos as an array of sizes; the last entry is the
    // largest.
    const largest = message.photo[message.photo.length - 1]!;
    try {
      const data = await client.fetchFile(largest.file_id);
      const mime = detectImageMime(data);
      if (!mime) {
        log.warn('photo skipped: unrecognized image format (file_id %s)', largest.file_id);
      } else {
        const block: ImageBlock = { type: 'data', mime, data };
        if (message.caption) {
          block.caption = { type: 'data', mime: 'text/plain', data: message.caption };
        }
        blocks.push(block);
      }
    } catch (err) {
      log.error('photo download failed: %s', errMessage(err));
    }
  }

  if (message.document) {
    // Documents are not inlined: the agent can fetch them on demand
    // through the `file` tool.
    const { file_id, file_name } = message.document;
    const caption = message.caption ? ` — caption: ${message.caption}` : '';
    blocks.push({
      type: 'data',
      mime: 'text/plain',
      data: `[document: ${file_name ?? 'unnamed'}, file_id: ${file_id}]${caption}`,
    });
  }

  if (message.text) {
    blocks.push({ type: 'data', mime: 'text/plain', data: message.text });
  }

  if (blocks.length === 0) {
    log.warn('message update %s has no content that can be forwarded', update.update_id);
    return null;
  }

  return {
    type: 'envelope',
    kind: 'message',
    from: userUrl(from.id),
    session: chatSession(message.chat.id),
    blocks,
  };
};

/**
 * Process one update with bounded retries. At-least-once delivery
 * (2026-09-22, Jacopo): the polling loop confirms an update's offset
 * only AFTER this resolves — success means the envelope has been
 * accepted by the harness; exhaustion means the update is dead-lettered
 * with a loud log rather than redelivered forever. A crash before
 * confirmation redelivers the update on the next boot.
 */
export const processUpdateWithRetry = async (
  deps: {
    handleUpdate: (update: TelegramUpdate) => Promise<void>;
    log: TelegramLogger;
    max_attempts?: number;
    sleep?: (ms: number) => Promise<void>;
  },
  update: TelegramUpdate,
): Promise<'processed' | 'dead-lettered'> => {
  const { handleUpdate, log } = deps;
  const max_attempts = deps.max_attempts ?? 3;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      await handleUpdate(update);
      return 'processed';
    } catch (err) {
      log.error(
        'telegram update processing error (attempt %d/%d): %s',
        attempt, max_attempts, errMessage(err),
      );
      if (attempt >= max_attempts) {
        log.error(
          'telegram update %s DEAD-LETTERED after %d failed attempts — confirming to avoid an infinite redelivery loop',
          update.update_id, max_attempts,
        );
        return 'dead-lettered';
      }
      await sleep(2_000 * attempt);
    }
  }
};
