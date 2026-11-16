
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { TextBlock } from "@loom/proto";
import { LocalToolServer } from "@loom/tools";
import pinetto from "pinetto";
import { TelegramClient } from "./client.js";
import { type TelegramConfig } from "./config.js";
import { processUpdateWithRetry, updateToEnvelope, type TelegramLogger } from "./notifier.js";
import { type TelegramUpdate } from "./types/message.js";

const execFileAsync = promisify(execFile);

const text = (data: string): TextBlock => ({ type: 'data', mime: 'text/plain', data });

/**
 * Telegram's sendVoice requires OGG/Opus (WAV goes out as a plain audio
 * document, not a playable voice note), so WAV files are converted
 * before dispatch: the transport owns format details.
 */
const wavToOgg = async (wav_path: string): Promise<string> => {
  const ogg_path = `${wav_path.replace(/\.wav$/, '')}.ogg`;
  await execFileAsync('ffmpeg', ['-y', '-i', wav_path, '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', ogg_path]);
  return ogg_path;
};

const probeDuration = async (path: string): Promise<number> => {
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]);
    return Number(stdout.trim());
  } catch {
    return 0;
  }
};

export interface TelegramToolServerOpts extends TelegramConfig {
  /** Tool server name, used by the manager to namespace tools. */
  name?: string;
  logger?: TelegramLogger;
}

/**
 * Telegram tool server.
 *
 * Outbound: exposes tools to send text, voice notes, photos and documents,
 * to download incoming media and to identify the bot.
 *
 * Inbound: once `start()`ed, long-polls the Bot API and forwards every
 * incoming message to the harness as a `message` envelope whose `from` is
 * `telegram:<user_id>` and whose `session` is `telegram:<chat_id>`.
 * Delivery is at-least-once: an update is confirmed only after
 * `sendEnvelope()` resolves (or after it is dead-lettered).
 */
export class TelegramToolServer extends LocalToolServer {

  readonly client: TelegramClient;

  #config: TelegramConfig;
  #log: TelegramLogger;
  #abort?: AbortController;
  #loop?: Promise<void>;

  constructor(opts: TelegramToolServerOpts) {
    super(opts.name ?? 'telegram');
    this.#config = opts;
    this.#log = opts.logger ?? pinetto({ prefix: 'tools:telegram', writer: process.stderr });
    this.client = new TelegramClient(opts.api_token, opts.api_base);
    this.#registerTools();
  }

  get media_dir(): string {
    return this.#config.media_dir ?? join(process.cwd(), 'media', 'telegram');
  }

  // ── Inbound ──

  /** Starts the long-polling loop. Calling it while running is a no-op. */
  start(): void {
    if (this.#loop) {
      return;
    }
    const abort = new AbortController();
    this.#abort = abort;
    this.#loop = this.#poll(abort.signal).finally(() => {
      this.#loop = undefined;
      this.#abort = undefined;
    });
  }

  /** Stops the polling loop, aborting any in-flight long poll. */
  override async stop(): Promise<void> {
    const loop = this.#loop;
    this.#abort?.abort();
    await loop;
  }

  #poll = async (signal: AbortSignal): Promise<void> => {
    const timeout = this.#config.poll_timeout_seconds ?? 30;
    while (!signal.aborted) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.client.fetchUpdates(timeout, signal);
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        this.#log.error('telegram poll error: %s', err instanceof Error ? err.message : String(err));
        await sleep(5_000, undefined, { signal }).catch(() => {});
        continue;
      }
      for (const update of updates) {
        // Stopping mid-batch leaves the rest unconfirmed: they are
        // redelivered on the next start.
        if (signal.aborted) {
          return;
        }
        await processUpdateWithRetry({ handleUpdate: this.#handleUpdate, log: this.#log }, update);
        this.client.confirmUpdates(update.update_id);
      }
    }
  };

  #handleUpdate = async (update: TelegramUpdate): Promise<void> => {
    const envelope = await updateToEnvelope(this.client, this.#log, update, this.#config.allowed_user_ids);
    if (envelope) {
      await this.sendEnvelope(envelope);
    }
  };

  // ── Outbound ──

  #registerTools() {

    this.addTool<{ text: string, chat_id: number }>(
      'send_text',
      'Send a plain-text Telegram message to a chat. For incoming messages, the chat_id is the numeric part of the `telegram:<chat_id>` session.',
      async ({ text: message_text, chat_id }) => {
        const message = await this.client.sendMessage(chat_id, message_text);
        return [text(`Sent — message_id: ${message.message_id}`)];
      },
    );

    this.addTool<{ path: string, chat_id: number }>(
      'send_voice',
      'Send an existing audio file as a voice note to a Telegram chat. `path` is an absolute path to the audio file; WAV is converted to OGG/Opus automatically.',
      async ({ path, chat_id }) => {
        const duration = await probeDuration(path);
        if (!Number.isFinite(duration) || duration <= 0) {
          return [text('Error: could not determine audio duration (ffprobe failed). Duration is required by the Telegram API.')];
        }
        const send_path = path.endsWith('.wav') ? await wavToOgg(path) : path;
        const message = await this.client.sendVoice(chat_id, send_path, duration);
        return [text(`Sent voice note — message_id: ${message.message_id}, duration: ${Math.round(duration)}s`)];
      },
    );

    this.addTool<{ path: string, chat_id: number, caption?: string }>(
      'send_photo',
      'Send a photo to a Telegram chat (JPEG/PNG/WebP/GIF — rendered inline in the conversation).',
      async ({ path, chat_id, caption }) => {
        const message = await this.client.sendPhoto(chat_id, path, caption);
        return [text(`Sent photo — message_id: ${message.message_id}`)];
      },
    );

    this.addTool<{ path: string, chat_id: number, caption?: string }>(
      'send_document',
      'Send any file to a Telegram chat as a document (no inline rendering — for PDFs, archives, screenshots as files, arbitrary attachments).',
      async ({ path, chat_id, caption }) => {
        const message = await this.client.sendDocument(chat_id, path, caption);
        return [text(`Sent document — message_id: ${message.message_id}`)];
      },
    );

    this.addTool<{}>(
      'me',
      'Get this bot\'s Telegram identity (id, username) — useful to share with users.',
      async () => {
        const me = await this.client.getMe();
        return [text(`Bot: @${me.username ?? me.id} (id ${me.id}, "${me.first_name}")`)];
      },
    );

    this.addTool<{ file_id: string, file_name?: string }>(
      'file',
      'Download any incoming Telegram media (photo, voice note, document, video note, audio) by its file_id into the media directory. Returns the saved path.',
      async ({ file_id, file_name }) => {
        const dir = this.media_dir;
        await mkdir(dir, { recursive: true });
        const ext = file_name?.includes('.') ? `.${file_name.split('.').pop()}` : '';
        const path = join(dir, `${file_id.slice(-16)}-${Date.now()}${ext}`);
        await this.client.downloadFile(file_id, path);
        return [text(`File saved to ${path}`)];
      },
    );

  }

}
