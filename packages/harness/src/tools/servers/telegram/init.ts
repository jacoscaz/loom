
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type TelegramConfig } from "./config.js";
import { TelegramClient } from "./client.js";
import { startTelegramNotifier } from "./notifier.js";
import { CompleteContext } from "../../../context.js";

/**
 * Minimal structural dependency on the host's notification bus. The
 * telegram package must NOT import harness types (circular dependency:
 * the harness depends on this package). Structural typing lets the
 * harness pass its real bus; this package only needs subscribe().
 */
export interface OutgoingBusLike {
  /**
   * Subscribe to bus notifications. The handler accepts the FULL
   * notification union (the harness bus routes all notification types);
   * telegram's handler filters for message/outgoing internally.
   * Declared as `any`-parameterized here because this package cannot
   * import the harness notification union (circular dependency).
   */
  subscribe(
    name: string,
    handler: (notification: any) => Promise<boolean> | boolean,
    priority?: 'high' | 'low',
  ): void;
}

export interface OutgoingLoggerLike {
  info(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface TelegramHostContext {
  buses: { notifications: OutgoingBusLike };
  logger: { child(prefix: string): OutgoingLoggerLike };
}


// ── Server ──

/**
 * Media directory for downloaded photos. Set by initTelegramMcpServer;
 * defaults to <cwd>/media/telegram when the tool is called before
 * configuration is known (defensive; init always sets it first).
 */
let mediaDir = join(process.cwd(), 'media', 'telegram');

/**
 * Voice notes produced by Telegram are OGG/Opus; synthesis output is
 * WAV. Telegram's sendVoice requires OGG/Opus (WAV goes out as a plain
 * audio document, not a playable voice note), so outgoing synthesized
 * audio is converted here before dispatch — the transport owns format
 * details, per the adapter doctrine.
 */
const wavToOgg = async (wav_path: string): Promise<string> => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const ogg_path = `${wav_path.replace(/\.wav$/, '')}.ogg`;
  await promisify(execFile)('ffmpeg', ['-y', '-i', wav_path, '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', ogg_path]);
  return ogg_path;
};

export const initTelegramTools = (ctx: CompleteContext) => {

  const client = new TelegramClient(ctx.config.telegram.api_token);
  const notifier = startTelegramNotifier(ctx, client);

  ctx.managers.tools.add<{ text: string, chat_id: number }>(
    'telegram_send_text',
    'Send Telegram Message',
    'Send a plain-text Telegram message to a chat (use the chat_id from an incoming message event).',
    true,
    async ({ text, chat_id }) => {
      const message = await client.sendMessage(chat_id, text);
      return [{ type: 'text', text: `Sent — message_id: ${message.message_id}` }];
    },
  );

  /**
   * Voice-note send. Cross-tool interaction is a direct call: synthesis
   * goes through ctx.speech.synthesize() — no bus, no transforms, no
   * "queued without delivery" state. The tool returns only after the
   * message is actually sent (or after an explicit, typed failure), so
   * delivery confirmation is structural: the message_id in the result
   * IS the confirmation. The old split — return "queued", confirm via a
   * later bus notification — placed delivery in the periphery of a
   * distributed flow; that failure class is gone.
   */
  ctx.managers.tools.add<{ text: string; chat_id: number; synthesize?: boolean }>(
    'telegram_send_voice',
    'Send Telegram Voice Message',
    'Send a voice note to a Telegram chat. Two modes: (1) synthesize: true/omitted — text is synthesized to speech with the configured voice (vox) and sent as a playable voice note; on synthesis failure the message is delivered as a plain text message instead (never dropped); (2) synthesize: false — text is an absolute path to an existing audio file (WAV is converted to OGG/Opus automatically) and it is sent directly.',
    true,
    async ({ text, chat_id, synthesize }) => {
      let send_path: string;
      let duration: number;

      if (synthesize === false) {
        // Direct file mode: `text` carries the audio file path.
        const path = text;
        try {
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]);
          duration = Number(stdout.trim());
        } catch {
          duration = 0;
        }
        if (!Number.isFinite(duration) || duration <= 0) {
          return [{ type: 'text', text: 'Error: could not determine audio duration (ffprobe failed). Duration is required by the Telegram API.' }];
        }
        send_path = path.endsWith('.wav') ? await wavToOgg(path) : path;
      } else {
        // Synthesis mode: direct call into the voice layer. Typed
        // SpeechResult keeps failure handling explicit — degrade to
        // text, never drop the message (the unsent-message lesson).
        const result = await ctx.speech.synthesize(text);
        if (!result.success) {
          const message = await client.sendMessage(chat_id, text);
          return [{ type: 'text', text: `Synthesis failed (${result.error}) — delivered as text instead. message_id: ${message.message_id}` }];
        }
        send_path = result.path.endsWith('.wav') ? await wavToOgg(result.path) : result.path;
        duration = result.duration;
      }

      const message = await client.sendVoice(chat_id, send_path, duration);
      return [{ type: 'text', text: `Sent voice note — message_id: ${message.message_id}, duration: ${Math.round(duration)}s` }];
    },
  );

  /**
   * Photo send. Same structural delivery confirmation as send_voice:
   * the tool returns only after Telegram has accepted the upload, and
   * the message_id in the result IS the confirmation.
   */
  ctx.managers.tools.add<{ path: string; chat_id: number; caption?: string }>(
    'telegram_send_photo',
    'Send Telegram Photo',
    'Send a photo to a Telegram chat (JPEG/PNG/WebP/GIF — rendered inline in the conversation).',
    true,
    async ({ path, chat_id, caption }) => {
      const message = await client.sendPhoto(chat_id, path, caption);
      return [{ type: 'text', text: `Sent photo — message_id: ${message.message_id}` }];
    },
  );

  /**
   * Document send: any file, no inline rendering — the Telegram
   * equivalent of an email attachment (screenshots-as-file, PDFs,
   * archives, arbitrary blobs). Same delivery semantics as send_photo.
   */
  ctx.managers.tools.add<{ path: string; chat_id: number; caption?: string }>(
    'telegram_send_document',
    'Send Telegram Document',
    'Send any file to a Telegram chat as a document (no inline rendering — for PDFs, archives, screenshots as files, arbitrary attachments).',
    true,
    async ({ path, chat_id, caption }) => {
      const message = await client.sendDocument(chat_id, path, caption);
      return [{ type: 'text', text: `Sent document — message_id: ${message.message_id}` }];
    },
  );

  ctx.managers.tools.add<{}>(
    'telegram_me',
    'Bot Identity',
    'Get this bot\'s Telegram identity (id, username) — useful to share with users.',
    false,
    async ({}) => {
      const me = await client.getMe();
      return [{ type: 'text', text: `Bot: @${me.username ?? me.id} (id ${me.id}, "${me.first_name}")` }];
    },
  );

  ctx.managers.tools.add<{ file_id: string; file_name?: string }>(
    'telegram_file',
    'Download Telegram File',
    'Download any incoming Telegram media (photo, voice note, document, video note, audio) by its file_id into the media directory. Returns the saved path — view images with the file-reading tool, process other media with CLI tools.',
    false,
    async ({ file_id, file_name }) => {
      const dir = mediaDir;
      await mkdir(dir, { recursive: true });
      const ext = file_name?.includes('.') ? `.${file_name.split('.').pop()}` : '';
      const path = join(dir, `${file_id.slice(-16)}-${Date.now()}${ext}`);
      await client.downloadFile(file_id, path);
      return [{ type: 'text', text: `File saved to ${path}` }];
    },
  );

};
