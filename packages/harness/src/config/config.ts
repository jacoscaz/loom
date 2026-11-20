
import { cast, ValidationError } from '@runtyped/type';
import { validationErrsToString, fillEnvVarsPlaceholders } from "@loom/utils";
// Not `import type`: runtime type reflection (used by `cast` below) needs
// these imports to survive compilation.
// import {
//   AnthropicCompletionModelOpts,
//   OpenAICompletionModelOpts,
//   TensorXCompletionModelOpts,
// } from "@loom/models";
import { AnthropicCompletionModelOpts } from '@loom/models/dist/completion/anthropic/model.js';
import { OpenAICompletionModelOpts } from '@loom/models/dist/completion/openai/model.js';
import { TensorXCompletionModelOpts } from '@loom/models/dist/completion/tensorx.js';
import { TelegramConfig } from "@loom/telegram";
import { resolve } from "node:path";
import { parse as parseTOML } from 'smol-toml';
import { readFile } from "node:fs/promises";
import assert from "node:assert";

/**
 * Completion model used by the agent. `options` are handed as-is to the
 * matching @loom/models adapter.
 */
export type ConfigModel =
  | { adapter: 'anthropic', options: AnthropicCompletionModelOpts }
  | { adapter: 'openai', options: OpenAICompletionModelOpts }
  | { adapter: 'tensorx', options: TensorXCompletionModelOpts };

export interface ConfigLogging {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /**
   * Whether log entries should be prefixed with an ISO 8601 datetime string.
   * If unspecified, defaults to `true`.
   */
  datetime?: boolean;
}

export interface ConfigPostgres {
  database: string;
  username?: string;
  password?: string;
  hostname?: string;
  port?: number;
  /**
   * Schema holding the harness' tables, created if missing. Defaults to
   * the connection's default search_path (usually `public`).
   */
  schema?: string;
}

export interface ConfigAgent {
  /** Replaces the built-in system prompt (see src/prompt.ts). */
  system_prompt?: string;
  /**
   * Maximum number of model queries per turn. Bounds the cost of a
   * runaway tool-calling loop. Defaults to 16.
   */
  max_steps_per_turn?: number;
}

export interface Config {
  /**
   * Path of the pid file backing the single-instance guard. Defaults to
   * harness.pid at the level of the harness package.json (see
   * src/pid-file.ts). A second harness instance finding a live pid file
   * exits immediately instead of racing the first.
   */
  pid_file?: string;
  logging: ConfigLogging;
  model: ConfigModel;
  telegram: TelegramConfig;
  postgres: ConfigPostgres;
  agent?: ConfigAgent;
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
    console.log(casted);
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
