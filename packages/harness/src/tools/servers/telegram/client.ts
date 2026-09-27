/**
 * Telegram Bot API client — thin, typed wrapper over the HTTP API.
 * Long-polling getUpdates with explicit, caller-driven offset
 * bookkeeping (fetch without advancing, confirm after durable
 * processing — at-least-once delivery); sendMessage for outbound.
 * No state beyond the update offset. Photos are resolved via getFile
 * and downloaded as raw bytes on demand.
 */
import { writeFile, readFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  type TelegramMessage,
  type TelegramUser,
  type TelegramUpdate,
} from "./types/message.js";

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

const DOCUMENT_MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  json: 'application/json',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};


export class TelegramClient {

  #token: string;
  #offset: number | null = null;
  #api_base: string;

  constructor(token: string, api_base: string = 'https://api.telegram.org') {
    this.#token = token;
    this.#api_base = api_base;
  }

  async #call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.#api_base}/bot${this.#token}/${method}`, {
      method: 'POST',
      body: JSON.stringify(params),
      headers: { 'Content-Type': 'application/json' },
    });
    const body = (await res.json()) as { ok: boolean, result?: T, description?: string };
    if (!body.ok) {
      throw new Error(`Telegram API error (${method}): ${body.description ?? 'unknown error'}`);
    }
    return body.result as T;
  }

  /**
   * Fetch pending updates via long polling WITHOUT advancing the offset:
   * returned updates stay unconfirmed and will be redelivered on the next
   * call unless confirmUpdates() records them as processed. At-least-once
   * delivery (2026-09-22, Jacopo): the caller confirms only AFTER the
   * resulting notification has durably reached the database — a crash
   * before that point redelivers instead of silently losing the message.
   */
  async fetchUpdates(timeoutSeconds: number = 30): Promise<TelegramUpdate[]> {
    const params: Record<string, unknown> = {
      timeout: timeoutSeconds,
      allowed_updates: ['message', 'edited_message'],
    };
    if (this.#offset !== null) {
      params.offset = this.#offset;
    }
    return await this.#call<TelegramUpdate[]>('getUpdates', params);
  }

  /**
   * Confirm all updates up to and including updateId (Telegram's offset
   * semantics: the next fetchUpdates will only return later updates).
   * Call only once the update's notification is durably persisted.
   */
  confirmUpdates(updateId: number): void {
    this.#offset = updateId + 1;
  }

  async sendMessage(chatId: number, text: string): Promise<TelegramMessage> {
    return await this.#call<TelegramMessage>('sendMessage', {
      chat_id: chatId,
      text,
    });
  }

  /**
   * Shared multipart upload for outbound media (voice, photo, document):
   * chat_id + optional extra fields + the file under the given form
   * field name, posted to the given Bot API method.
   */
  async #sendMultipartFile(
    method: string,
    chatId: number,
    field: string,
    filePath: string,
    mimeType: string,
    fileName: string,
    extra: Record<string, string> = {},
  ): Promise<TelegramMessage> {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    for (const [key, value] of Object.entries(extra)) {
      form.append(key, value);
    }
    const bytes = await readFile(filePath);
    form.append(field, new Blob([new Uint8Array(bytes)], { type: mimeType }), fileName);
    const res = await fetch(`${this.#api_base}/bot${this.#token}/${method}`, { method: 'POST', body: form });
    const json = await res.json() as { ok?: boolean, result?: TelegramMessage, description?: string };
    if (!res.ok || !json.ok || !json.result) {
      throw new Error(`${method} failed: HTTP ${res.status}${json.description ? ` — ${json.description}` : ''}`);
    }
    return json.result;
  }

  /**
   * Send a voice note. Audio must be OGG/Opus (Telegram's documented
   * voice-note format; MP3 falls back to a plain audio file).
   * Duration in seconds is REQUIRED by the API — enforced upstream by
   * the mandatory duration on voice blocks.
   */
  async sendVoice(chatId: number, filePath: string, durationSeconds: number): Promise<TelegramMessage> {
    return await this.#sendMultipartFile(
      'sendVoice', chatId, 'voice', filePath, 'audio/ogg', 'voice.ogg',
      { duration: String(Math.max(1, Math.round(durationSeconds))) },
    );
  }

  /**
   * Send a photo by absolute file path (JPEG/PNG — Telegram renders
   * these inline). MIME type is derived from the extension; unknown
   * extensions fall back to JPEG, which Telegram re-encodes server-side.
   * Optional caption is rendered below the photo.
   */
  async sendPhoto(chatId: number, filePath: string, caption?: string): Promise<TelegramMessage> {
    const mime = IMAGE_MIME_BY_EXT[filePath.toLowerCase().split('.').pop() ?? ''] ?? 'image/jpeg';
    return await this.#sendMultipartFile(
      'sendPhoto', chatId, 'photo', filePath, mime, basename(filePath),
      caption ? { caption } : {},
    );
  }

  /**
   * Send any file as a document (no inline rendering — screenshots as
   * files, PDFs, archives, arbitrary attachments). MIME type is derived
   * from the extension with a generic-octet-stream fallback.
   * Optional caption is rendered below the document.
   */
  async sendDocument(chatId: number, filePath: string, caption?: string): Promise<TelegramMessage> {
    const mime = DOCUMENT_MIME_BY_EXT[filePath.toLowerCase().split('.').pop() ?? ''] ?? 'application/octet-stream';
    return await this.#sendMultipartFile(
      'sendDocument', chatId, 'document', filePath, mime, basename(filePath),
      caption ? { caption } : {},
    );
  }

  /** Bootstrap utility: who is this bot? */
  async getMe(): Promise<TelegramUser> {
    return await this.#call<TelegramUser>('getMe', {});
  }

  /**
   * Resolve a file_id to a downloadable URL via getFile. Telegram
   * file paths are valid for ~1 hour after resolution.
   */
  async getFileUrl(fileId: string): Promise<string> {
    const file = await this.#call<{ file_path?: string }>('getFile', { file_id: fileId });
    if (!file.file_path) {
      throw new Error(`Telegram getFile returned no file_path for ${fileId}`);
    }
    return `${this.#api_base}/file/bot${this.#token}/${file.file_path}`;
  }

  /**
   * Download a photo by file_id to destinationPath. Returns the path.
   */
  async downloadPhoto(fileId: string, destinationPath: string): Promise<string> {
    return await this.downloadFile(fileId, destinationPath);
  }

  /**
   * Download any Telegram file (photo, voice note, document, ...) by
   * file_id to destinationPath. Returns the path.
   */
  async downloadFile(fileId: string, destinationPath: string): Promise<string> {
    const url = await this.getFileUrl(fileId);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Telegram file download failed: HTTP ${res.status}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    await writeFile(destinationPath, bytes);
    return destinationPath;
  }

}
