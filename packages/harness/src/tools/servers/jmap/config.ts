import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseTOML } from "smol-toml";
import { cast, ValidationError } from "@runtyped/type";
import { validationErrsToString, fillEnvVarsPlaceholders } from "@loom/utils";

/**
 * Configuration of the JMAP mail server. Owned by this package — the
 * harness (or a standalone deployment) supplies values, but the type
 * and loader live here.
 */
export interface JmapConfig {
  api_url: string;
  session_url: string;
  api_token: string;
  email_address: string;
  /** Inbox polling interval in milliseconds. */
  poll_interval_ms?: number;
}

// Function DECLARATION, not an arrow const — see config.ts for why
// (the runtyped compiler drops cast<T> type arguments inside arrow
// functions, making cast() throw NoTypeReceived at runtime).
export async function loadJmapConfig(file_path: string): Promise<JmapConfig> {
  file_path = resolve(process.cwd(), file_path);
  const as_string = await readFile(file_path, 'utf8');
  const as_toml = parseTOML(as_string) as Record<string, unknown>;
  fillEnvVarsPlaceholders(as_toml, process.env);
  return cast<JmapConfig>(as_toml);
}
