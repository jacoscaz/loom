import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbstractSynthesisModel, type SynthesisResult } from "./abstract.js";

export interface OpenAISynthesisModelOpts {
  model: string;
  /** Optional; local endpoints typically need no key. */
  api_key?: string;
  /** Default 'https://api.openai.com/v1'. */
  base_url?: string;
  /** Speaker voice id (endpoint-specific, e.g. 'alloy', 'af_nicole'). */
  voice: string;
  /** Audio format requested from the endpoint. Default 'mp3'. */
  response_format?: 'mp3' | 'opus' | 'wav' | 'ogg';
  /** Speech speed multiplier where supported. Default 1.0. */
  speed?: number;
}

/**
 * Adapter for OpenAI-compatible speech-synthesis endpoints
 * (POST /audio/speech, JSON body, audio bytes response). Works with any
 * service implementing the standard: OpenAI, kokoro-fastapi-style
 * wrappers, etc.
 *
 * The adapter writes raw response bytes to the destination path and
 * derives duration from WAV headers when available, or from the
 * X-Duration-Seconds response header for other formats.
 */
export class OpenAISynthesisModel extends AbstractSynthesisModel {

  #opts: OpenAISynthesisModelOpts;
  #endpoint: string;

  constructor(opts: OpenAISynthesisModelOpts) {
    super();
    this.#opts = opts;
    const base = (opts.base_url ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.#endpoint = `${base}/audio/speech`;
  }

  async synthesize(text: string, out_path?: string): Promise<SynthesisResult> {
    const format = this.#opts.response_format ?? 'mp3';
    const body: Record<string, unknown> = {
      model: this.#opts.model,
      input: text,
      voice: this.#opts.voice,
      response_format: format,
    };
    if (this.#opts.speed !== undefined) {
      body.speed = this.#opts.speed;
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.#opts.api_key) {
      headers['Authorization'] = `Bearer ${this.#opts.api_key}`;
    }

    const res = await fetch(this.#endpoint, { method: 'POST', body: JSON.stringify(body), headers });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Synthesis request failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) {
      throw new Error('Synthesis response body is empty');
    }

    // Derive the duration before writing: a payload whose duration cannot
    // be determined must not leave a file behind.
    const duration = deriveDuration(bytes, format, res.headers);
    const target = out_path ?? join(tmpdir(), `loom-synthesis-${Date.now()}.${format}`);
    await writeFile(target, bytes);

    return {
      path: target,
      duration,
      format,
      voice: this.#opts.voice,
    };
  }

}

/**
 * Duration in seconds. WAV: parsed from the header (exact). Otherwise:
 * X-Duration-Seconds response header when the endpoint provides it.
 * Otherwise throw rather than return a wrong duration — a wrong duration
 * is worse than a failed synthesis (the caller can retry with wav).
 */
const deriveDuration = (bytes: Uint8Array, format: string, headers: Headers): number => {
  if (format === 'wav') {
    return wavDurationSeconds(bytes);
  }
  const header_value = headers.get('x-duration-seconds');
  if (header_value) {
    const parsed = Number(header_value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  throw new Error(`Cannot derive audio duration for format '${format}'. Request response_format 'wav' or use an endpoint that reports X-Duration-Seconds.`);
};

/**
 * Exact duration of a WAV payload: data_size / byte_rate, walking the
 * RIFF chunks since header layout can vary.
 */
export const wavDurationSeconds = (bytes: Uint8Array): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, len: number) => String.fromCharCode(...bytes.slice(offset, offset + len));
  if (bytes.length < 44 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') {
    throw new Error('Synthesis produced a non-WAV payload despite requesting wav format');
  }
  let offset = 12;
  let data_size = 0;
  let byte_rate = 0;
  while (offset + 8 <= bytes.length) {
    const chunk_id = ascii(offset, 4);
    const chunk_size = view.getUint32(offset + 4, true);
    if (chunk_id === 'fmt ') {
      byte_rate = view.getUint32(offset + 16, true);
    } else if (chunk_id === 'data') {
      data_size = Math.min(chunk_size === 0xFFFFFFFF ? 0 : chunk_size, bytes.length - offset - 8);
      if (data_size === 0) data_size = bytes.length - offset - 8;
      break;
    }
    offset += 8 + chunk_size + (chunk_size % 2);
  }
  if (data_size <= 0 || byte_rate <= 0) {
    throw new Error('WAV header missing fmt/data chunk information needed for duration');
  }
  return data_size / byte_rate;
};
