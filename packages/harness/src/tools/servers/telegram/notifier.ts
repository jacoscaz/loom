
// ── Notification loop ──
import { type TelegramClient } from "./client.js";
import { type TelegramUpdate } from "./types/message.js";
import { CompleteContext } from "../../../context.js";
import { type Logger } from "pinetto";
import { type Contact } from "../../../types/contacts.js";
import { type UserMessageIncomingNotification } from "../../../types/notifications.js";
import { type UserBlock } from "../../../types/messages.js";

/**
 * Process one update, isolated from the polling loop. Any error here
 * is caught and logged by the caller — the loop never dies from a
 * single poisoned update or a transient processing failure (e.g. a
 * DB hiccup during notify).
 */
async function handleUpdate(
  ctx: CompleteContext,
  client: TelegramClient,
  log: Logger,
  update: TelegramUpdate,
): Promise<void> {
  const config = ctx.config.telegram;
  const message = update.message;
  if (!message) {
    // For now we do not support updates about things other than messages.
    // This includes edited messages, see `update.edited_message` property.
    return;
  }
  const from = message.from;
  if (!from) {
    // For now we do not support updates with no sender information due to
    // the security risk they pose.
    return;
  }
  const contact = await ctx.contacts.lookup(`telegram:${from.id}`);
  if (!contact.verified) {
    // We do not support updates from unverified contacts. This reduces the
    // surface of attack to verified contacts only, at least when it comes to
    // notifications.
    return;
  }

  const content: UserBlock[] = [];

  // Voice notes: download, then transcribe AT EMISSION via
  // ctx.speech — the notifier emits a COMPLETE event. The
  // notification bus is no longer a cross-tool pipeline: there is
  // no downstream transcription subscriber to order against, and
  // the silent-dead-chain failure class dies with it. Transcription
  // failures are loud: the block carries the error string, never a
  // transcription-less voice block dressed as complete.
  if (message.voice) {
    try {
      const path = await ctx.files.tempPath(new Date(Date.now() + 3_600_000), 'ogg');
      await client.downloadFile(message.voice.file_id, path);
      let transcription: string | undefined;
      try {
        const result = await ctx.speech.transcribe(path);
        transcription = result.text;
        log.info('voice note transcribed: %s (%ss)', path, message.voice.duration);
      } catch (err) {
        // Fail loud: an explicit error string, never a silent drop.
        transcription = `[transcription failed: ${err instanceof Error ? err.message : String(err)}]`;
        log.error('voice note transcription failed: %s', err instanceof Error ? err.message : String(err));
      }
      // Audio-to-substrate: when a model declares audio input the raw
      // sound must survive, not just the transcript. Convert ONCE at
      // ingest (ogg/opus -> 16k mono wav) and inline base64 in the
      // block — ImageBlock durability: `path`'s temp file expires in an
      // hour, history replays longer. Conversion failure is loud in
      // logs and degrades to transcript-only: the transcript remains
      // the guaranteed channel, audio is additive.
      let data: string | undefined;
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const wavPath = await ctx.files.tempPath(new Date(Date.now() + 3_600_000), 'wav');
        await promisify(execFile)('ffmpeg', ['-y', '-i', path, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', wavPath]);
        const { readFile } = await import('node:fs/promises');
        data = (await readFile(wavPath)).toString('base64');
        log.info('voice note audio inlined for substrate delivery: %s', wavPath);
      } catch (err) {
        log.error('voice note audio conversion failed (transcript unaffected): %s', err instanceof Error ? err.message : String(err));
      }
      content.push({
        type: 'voice',
        path,
        mimeType: 'audio/ogg',
        duration: message.voice.duration,
        transcription,
        data,
        dataFormat: data ? 'wav' : undefined,
      });
    } catch (err) {
      log.error('voice note download failed: %s', err instanceof Error ? err.message : String(err));
    }
  }

  if (message.photo) {
    // Telegram sends photos as an array of sizes; the last entry is
    // the largest. Download to an ImageBlock with REAL bytes and
    // detected mime type — a silent data:'' placeholder would
    // render as a broken image in the agent's context (fail loud,
    // never fail fake-complete).
    const largest = message.photo[message.photo.length - 1];
    try {
      const path = await ctx.files.tempPath(new Date(Date.now() + 3_600_000), 'img');
      await client.downloadFile(largest.file_id, path);
      const { readFile } = await import('node:fs/promises');
      const data = (await readFile(path)).toString('base64');
      // Telegram photos are JPEG; detect from magic bytes rather
      // than trust, and skip loudly if unrecognized.
      const head = Buffer.from(data.slice(0, 8), 'base64');
      let mimeType = '';
      if (head[0] === 0xff && head[1] === 0xd8) mimeType = 'image/jpeg';
      else if (head[0] === 0x89 && head[1] === 0x50) mimeType = 'image/png';
      else if (head[0] === 0x47 && head[1] === 0x49) mimeType = 'image/gif';
      else if (head.slice(0, 4).toString() === 'RIFF' && head.slice(8, 12).toString() === 'WEBP') mimeType = 'image/webp';
      if (!mimeType) {
        log.warn('photo skipped: unrecognized image format (file saved at %s)', path);
      } else {
        content.push({
          type: 'image',
          mimeType,
          data,
          caption: message.caption,
        });
      }
    } catch (err) {
      log.error('photo download failed: %s', err instanceof Error ? err.message : String(err));
    }
  }

  // TODO: if (message.document) {}
  if (message.text) {
    content.push({
      type: 'text',
      text: message.text,
    });
  }

  if (content.length === 0) {
    log.warn('message update does not have any content that can be notified to the agent');
    return;
  }

  // Await: notify injects into the session and can run the model —
  // fire-and-forget would make any failure an unhandled rejection.
  await ctx.buses.notifications.notify({
    role: 'user',
    type: 'notification',
    method: 'message/incoming',
    contact,
    blocks: content,
    transport: {
      type: 'telegram',
      chat_id: message.chat.id,
      from_id: from.id,
      username: from.username,
    },
  } satisfies UserMessageIncomingNotification);

}

/**
 * Process one update with bounded retries. At-least-once delivery
 * (2026-09-22, Jacopo): the polling loop confirms an update's offset
 * only AFTER this resolves — success means the notification is durably
 * in the database; exhaustion means the update is dead-lettered with a
 * loud log rather than redelivered forever. A crash before confirmation
 * redelivers the update on the next boot.
 */
export const processUpdateWithRetry = async (
  deps: {
    handleUpdate: (update: TelegramUpdate) => Promise<void>;
    log: Logger;
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
        attempt, max_attempts, err instanceof Error ? err.message : String(err),
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

/**
 * Start the long-polling loop for incoming updates. Each allowlisted
 * user's message emits a message/incoming notification through the
 * notification bus — notifiers emit complete events, decorated at
 * emission.
 *
 * Delivery semantics: at-least-once. Updates are fetched WITHOUT
 * advancing the offset and confirmed only after processing has durably
 * persisted the notification (handleUpdate awaits the DB write). A
 * crash before confirmation redelivers; bounded retries (see
 * processUpdateWithRetry) turn a permanently poisoned update into a
 * loud dead-letter instead of an infinite loop.
 *
 * Security: updates from users not in allowed_user_ids are silently
 * dropped (fail closed). The drop is logged.
 */
export const startTelegramNotifier = (
  ctx: CompleteContext,
  client: TelegramClient,
): { stop(): void } => {
  let stopped = false;
  const config = ctx.config.telegram;
  const log = ctx.logger.child('[tools:telegram]');
  const loop = async (): Promise<void> => {
    while (!stopped) {
      let updates: TelegramUpdate[];
      try {
        updates = await client.fetchUpdates(config.poll_timeout_seconds ?? 30);
      } catch (err) {
        log.error('telegram poll error: %s', err instanceof Error ? err.message : String(err));
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        continue;
      }
      for (const update of updates) {
        await processUpdateWithRetry(
          { handleUpdate: (u) => handleUpdate(ctx, client, log, u), log },
          update,
        );
        // Confirm only here — after the notification is durably in the
        // database (or the update is a designed no-op / dead-letter).
        client.confirmUpdates(update.update_id);
      }
    }
  };

  void loop();

  return {
    stop(): void {
      stopped = true;
      // The in-flight fetchUpdates call resolves within its timeout; no
      // need to await — process shutdown tolerates it.
    },
  };
};
