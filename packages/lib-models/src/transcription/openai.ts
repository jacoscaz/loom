import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { AbstractTranscriptionModel, type TranscriptionResult } from "./abstract.js";

export interface OpenAITranscriptionModelOpts {
  model: string;
  /** Optional; some local endpoints (whisper-server) need no key. */
  api_key?: string;
  /** Default 'https://api.openai.com/v1'. */
  base_url?: string;
  /** ISO-639-1 hint; omit to let the model auto-detect. */
  language?: string;
  /** Initial prompt biasing transcription (names, vocabulary). */
  prompt?: string;
}

/**
 * Adapter for OpenAI-compatible transcription endpoints
 * (POST /audio/transcriptions, multipart form-data). Works with any
 * service implementing the standard: OpenAI, whisper.cpp's
 * whisper-server, faster-whisper-server, etc.
 *
 * OGG/Opus note: the OpenAI API standard only guarantees WAV/MP3;
 * whisper-server handles arbitrary formats when built with --convert
 * (delegates to ffmpeg). Other endpoints may require pre-conversion —
 * that is a service capability, not an adapter concern.
 */
export class OpenAITranscriptionModel extends AbstractTranscriptionModel {

  #opts: OpenAITranscriptionModelOpts;
  #endpoint: string;

  constructor(opts: OpenAITranscriptionModelOpts) {
    super();
    this.#opts = opts;
    const base = (opts.base_url ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.#endpoint = `${base}/audio/transcriptions`;
  }

  async transcribe(filePath: string, language?: string): Promise<TranscriptionResult> {
    const started = Date.now();
    const form = new FormData();
    const bytes = await readFile(filePath);
    form.append('file', new Blob([new Uint8Array(bytes)]), basename(filePath) || 'audio');
    form.append('model', this.#opts.model);
    const effective_language = language ?? this.#opts.language;
    if (effective_language) {
      form.append('language', effective_language);
    }
    if (this.#opts.prompt) {
      form.append('prompt', this.#opts.prompt);
    }
    form.append('response_format', 'json');

    const headers: Record<string, string> = {};
    if (this.#opts.api_key) {
      headers['Authorization'] = `Bearer ${this.#opts.api_key}`;
    }

    const res = await fetch(this.#endpoint, { method: 'POST', body: form, headers });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Transcription request failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
    }
    const json = await res.json() as { text?: string, language?: string };
    if (typeof json.text !== 'string') {
      throw new Error('Transcription response missing text field');
    }
    return {
      text: json.text,
      language: json.language,
      duration_ms: Date.now() - started,
    };
  }

}
