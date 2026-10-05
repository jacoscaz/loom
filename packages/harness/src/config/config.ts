
import { cast, ValidationError} from '@runtyped/type';
import { validationErrsToString, fillEnvVarsPlaceholders } from "@loom/utils";
import { resolve } from "node:path";
import { parse as parseTOML } from 'smol-toml';
import { readFile } from "node:fs/promises";
import assert from "node:assert";
import { TelegramConfig } from '../tools/servers/telegram/config.js';
import { JmapConfig } from '../tools/servers/jmap/config.js';

export interface ConfigPostgres {
  username?: string;
  password?: string;
  hostname?: string;
  port?: number;
  database: string;
}

/**
 * Content modalities a model can consume/produce. Defaults to text-only when
 * absent. The session runner filters content blocks unsupported by the active
 * model before sending (e.g., images to a text-only model are replaced with
 * placeholder notices rather than sent; voice likewise, or kept as native
 * audio on audio-capable wires).
 */
export interface ConfigModalities {
  images?: boolean;
  /** Model accepts native audio input (voice notes project as input_audio). */
  audio?: boolean;
}

export interface ConfigModelBase {
  /** Unique model identifier internal to the harness (e.g. 'z-ai/glm-5.3-flash'). */
  id: string;
  /** Timeout for model queries, in milliseconds. */
  timeout: number;
  /**
   * Declarative guidance for the agent's model selection — surfaced in the
   * boot event's available-models menu so the agent can choose substrates
   * without a-priori knowledge of each one's strengths and weaknesses
   * (Jacopo, PR #27 review round 2).
   */
  guidance?: string;
  adapter: string;
  options?: Record<string, any>;
  max_output_size: number;
  max_context_size: number;
  modalities?: ConfigModalities;
  /**
   * Whether thinking blocks should be included in inference requests.
   * Depends on the model. True for DeepSeek and Anthropic, false for
   * most others.
   */
  replay_thinking?: boolean;
}

export interface ConfigEmbeddingsModelBase {
  adapter: string;
  options: Record<string, any> & {
    /** Vector dimensionality produced by this model. The continuity
     *  store's embedding column is aligned to this at every boot:
     *  retyped to vector(dimensions), nulled entirely on content
     *  mismatch (the embedder loop then re-embeds in the background). */
    dimensions?: number;
  };
}

export interface ConfigModelOpenAI extends ConfigModelBase {
  adapter: 'openai';
  options: {
    model: string;
    api_key: string;
    base_url?: string;
    reasoning?: { effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; };
    extras?: Record<string, any>;
  };
};

export interface ConfigModelAnthropic extends ConfigModelBase {
  adapter: 'anthropic';
  options: {
    model: string;
    api_key: string;
    base_url?: string;
    /**
     * Prompt-caching breakpoint TTL for the stable prefix (system +
     * conversation tail). 'off' disables cache_control markers
     * entirely. Default '1h' — the 5m default expires across this
     * harness's heartbeat-spaced activations.
     */
    prompt_cache_ttl?: '5m' | '1h' | 'off';
    extras?: Record<string, any>;
  };
};

export type ConfigSessionModel = ConfigModelOpenAI | ConfigModelAnthropic;

/**
 * Reasoning-effort vocabulary: the harness's common language for how hard
 * a session model should think. Adapters translate these to their native
 * equivalents (the OpenAI adapter passes them through unchanged); adapters
 * with no notion of reasoning effort no-op the request (log + false).
 */


export interface ConfigEmbeddingsModelOpenAI extends ConfigEmbeddingsModelBase {
  adapter: 'openai';
  options: {
    model: string;
    api_key: string;
    base_url?: string;
    /** Vector dimensionality produced by this model. The continuity
     *  store's embedding column is aligned to this at every boot:
     *  retyped to vector(dimensions), nulled entirely on content
     *  mismatch (the embedder loop then re-embeds in the background). */
    dimensions?: number;
    extras?: Record<string, any>;
  };
}

export type ConfigEmbeddingModel = ConfigEmbeddingsModelOpenAI;

/**
 * Transcription (speech-to-text) model configuration. Optional in the
 * Config root: when absent, the harness performs no automatic
 * transcription and audio-artifact notifications pass through
 * untouched.
 */
export interface ConfigTranscriptionModelOpenAI {
  adapter: 'openai';
  options: {
    model: string;
    /** Optional; some local endpoints (whisper-server) need no key. */
    api_key?: string;
    base_url?: string;
    /** ISO-639-1 hint; omit to let the model auto-detect. */
    language?: string;
    /** Initial prompt biasing transcription (names, vocabulary). */
    prompt?: string;
  };
}

export type ConfigTranscriptionModel = ConfigTranscriptionModelOpenAI;

/**
 * Speech synthesis (text-to-speech) model configuration. Optional: when
 * absent, the speech server's synthesize path is unavailable and outgoing
 * messages always dispatch as text. Mirrors the transcription model
 * pattern: adapter + options, adapters own all format details.
 */
export interface ConfigSynthesisModelOpenAI {
  adapter: 'openai';
  options: {
    model: string;
    /** Optional; local endpoints typically need no key. */
    api_key?: string;
    base_url?: string;
    /** Speaker voice id (endpoint-specific, e.g. 'alloy', 'af_nicole'). */
    voice: string;
    /** Audio format requested from the endpoint. Default 'mp3'. */
    response_format?: 'mp3' | 'opus' | 'wav' | 'ogg';
    /** Speech speed multiplier where supported. Default 1.0. */
    speed?: number;
  };
}

export type ConfigSynthesisModel = ConfigSynthesisModelOpenAI;

/**
 * FileManager (temporary-path allocation + expiration cleanup)
 * configuration. Optional — defaults apply when absent.
 */
export interface ConfigFiles {
  /** Root directory for expiring temp files. Defaults to <cwd>/media/tmp. */
  temp_dir?: string;
  /** Cleanup sweep interval in milliseconds. Default 60000. */
  cleanup_interval_ms?: number;
}

export interface ConfigLogging {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /**
   * Whether log entries should be prefixed with an ISO 8601 datetime string.
   * If unspecified, defaults to `true`.
   */
  datetime?: boolean;
  /**
   * Directory for the monologue log (the human-facing mirror of the
   * session stream) and its rotated files. Defaults to
   * /var/log/loom.
   */
  monologue_dir?: string;
}

export interface ConfigHeartbeat {
  /** Heartbeat (check) interval in milliseconds — how often the runner polls for pending work */
  interval: number;
  /** Minimum time between heartbeat-driven activations, in milliseconds.
   *  This is the agent's presence rhythm: how often the agent activates
   *  when nothing external triggers it. Independent of `interval`, which
   *  is only the cheap internal check cadence.
   *  Note: effectively "X ms of quiet", not "X ms of clock time" —
   *  heartbeat activations are suppressed while the quiet period below
   *  keeps deferring them during ongoing activity. */
  activation_interval_ms: number;
  /** Quiet period after ANY activation, in milliseconds, during which
   *  heartbeat-driven activations are suppressed. Prevents the synthetic
   *  activation prompt from landing in the middle of an ongoing exchange
   *  with a slow-typing human (or a long-working agent). Pending messages
   *  are still drained; only the heartbeat prompt is deferred. 0 disables. */
  quiet_after_ms: number;
}

export interface ConfigCrontab {
  /** Wall-clock cap per hook execution, milliseconds. The child is
   *  SIGKILLed at the cap. Default 60000. */
  timeout_ms?: number;
  /** Output capture cap per firing, bytes — also the child's maxBuffer.
   *  Full (capped) output is recorded in the row's last_output regardless
   *  of match/notify. Default 8192. */
  max_output_bytes?: number;
}

export interface ConfigSession {
  /** Maximum activation-loop iterations per run() for the main session
   *  runner. A runaway loop costs bounded tokens; the limit-reached
   *  condition is visible in the journal and the next heartbeat resumes
   *  work with fresh context. Ephemeral runners (distiller, compactor)
   *  pass their own tighter limits explicitly. */
  max_activations_per_run: number;
}

export interface Config {
  tz: string;
  /**
   * Path of the pid file backing the single-instance guard. Defaults to
   * harness.pid at the level of the harness package.json (see
   * src/pid-file.ts). A second harness instance finding a live pid file
   * exits immediately instead of racing the first.
   */
  pid_file?: string;
  models: {
    /**
     * Session models, in priority order. The FIRST entry is the default
     * every session starts on; sessions may switch to any other entry at
     * runtime via the session switch tool. Restarts reset to
     * the first entry (V1: switch state is not persisted).
     */
    session: ConfigSessionModel[];
    embedding: ConfigEmbeddingModel;
    transcription?: ConfigTranscriptionModel;
    synthesis?: ConfigSynthesisModel;
    /** Dedicated model for distillation (continuity maintenance). Static — not switchable. */
    distillation: ConfigSessionModel;
    /** Dedicated model for compaction. Static — not switchable. */
    compaction: ConfigSessionModel;
    /** Dedicated model for recollection query gating/subject extraction.
     *  Optional: when absent, the recaller performs no automatic
     *  recollection at all (zero injections) — grounding remains the
     *  agent's conscious work via continuity queries. */
    extraction?: ConfigSessionModel;
  };
  logging: ConfigLogging;
  /** JMAP mail server configuration. */
  mail: JmapConfig;
  /** Telegram server configuration. */
  telegram: TelegramConfig;
  heartbeat: ConfigHeartbeat;
  /** Session runner limits. Optional — defaults apply when absent. */
  session?: Partial<ConfigSession>;
  /** Crontab hook execution caps. Optional — defaults apply when absent. */
  crontab?: ConfigCrontab;
  /** Temp-file management (FileManager). Optional — defaults apply when absent. */
  files?: ConfigFiles;
  postgres: ConfigPostgres;
}

/**
 * Keys present in the raw parsed config but absent from the cast result
 * were silently stripped by validation — the August 2026 failure class
 * (a misplaced `modalities` block vanished without a trace and the
 * harness ran on without it). The open `options`/`extras` regions
 * survive cast (index signatures), so a stripped key here is a
 * genuinely unknown structural key — worth failing the boot for.
 *
 * Key-path diff only, deliberately value-agnostic: cast does not coerce
 * env-placeholder numbers, and it doesn't need to for this check.
 */
export const findStrippedKeys = (raw: unknown, casted: unknown, path = ''): string[] => {
  if (Array.isArray(raw)) {
    return (casted === undefined)
      ? [path].filter(p => p !== '')
      : raw.flatMap((v, i) => findStrippedKeys(v, (casted as unknown[])[i], `${path}[${i}]`));
  }
  if (raw !== null && typeof raw === 'object') {
    const out: string[] = [];
    for (const [k, v] of Object.entries(raw)) {
      const p = path ? `${path}.${k}` : k;
      const c = (casted as Record<string, unknown> | undefined)?.[k];
      if (c === undefined) {
        out.push(p);
        continue;
      }
      out.push(...findStrippedKeys(v, c, p));
    }
    return out;
  }
  return [];
};

export const getConfigFromProcessArgv = async (): Promise<Config> => {
  let file_path = process.argv[2];
  assert(file_path, 'Missing config file path');
  file_path = resolve(process.cwd(), file_path);
  try {
    const as_string = await readFile(file_path, 'utf8');
    const as_toml = parseTOML(as_string) as Record<string, unknown>;
    fillEnvVarsPlaceholders(as_toml, process.env);
    const casted = cast<Config>(as_toml);
    const stripped = findStrippedKeys(as_toml, casted);
    if (stripped.length > 0) {
      throw new Error(
        `Failed to validate config file ${file_path}: unrecognized key(s) would be silently dropped: ` +
        `${stripped.join(', ')} — fix or remove them (unknown keys are rejected everywhere except ` +
        `open regions of the type, e.g. a model's options.extras block)`,
      );
    }
    return casted;
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new Error(`Failed to parse config file ${file_path}: ${validationErrsToString(err.errors)}`);
    }
    throw err;
  }
};
