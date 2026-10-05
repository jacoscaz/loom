
import { execFile } from 'node:child_process';

/**
 * Mechanical execution caps for crontab hooks (design of record: coord
 * 8-2026-10-05-heartbeat-polling-hooks; anchor #48 in its post-2026-10-05
 * CODE GOVERNANCE form: "what runs unattended gets mechanical caps").
 *
 * Caps live in the runner's invocation, never in the hook author's
 * command string — the guarantee is structure, not discipline. The
 * wall-clock timeout is enforced by execFile (SIGKILL); CPU seconds and
 * writable-file size are ulimits prefixed to the script, invisible to
 * the command itself.
 */

export interface HookCaps {
  /** Wall-clock cap per execution, milliseconds. */
  timeout_ms: number;
  /** Output capture cap, bytes. Also the child's maxBuffer. */
  max_output_bytes: number;
}

export interface ExecResult {
  /** Process exit code; null when killed by signal or buffer-capped. */
  exit_code: number | null;
  /** True when the wall-clock timeout fired. */
  timed_out: boolean;
  /** Combined stdout+stderr, sections labeled, truncated to the cap. */
  output: string;
}

export const DEFAULT_HOOK_CAPS: HookCaps = {
  timeout_ms: 60_000,
  max_output_bytes: 8192,
};

/** Truncate text to a byte budget on a safe boundary (never mid-ellipsis). */
export const truncateOutput = (text: string, max_bytes: number): string => {
  const budget = Math.max(0, max_bytes - 32); // room for the marker
  if (Buffer.byteLength(text, 'utf8') <= max_bytes) return text;
  let cut = budget;
  while (cut > 0 && (text.charCodeAt(cut) & 0xc0) === 0x80) cut--; // backtrack UTF-8 continuation bytes
  return text.slice(0, cut) + '\n…[truncated]';
};

export const executeHook = (command: string, caps: HookCaps): Promise<ExecResult> =>
  new Promise(resolve => {
    // ulimit -t: CPU seconds (>= 1 so sub-second caps still bound).
    // ulimit -f: writable-file size, 1024-byte blocks; headroom over the
    // output cap — sensors signal, they do not hoard.
    const cpu_seconds = Math.max(1, Math.ceil(caps.timeout_ms / 1000));
    const file_blocks = Math.max(1, Math.ceil((caps.max_output_bytes * 4) / 1024));
    const script = `ulimit -t ${cpu_seconds}; ulimit -f ${file_blocks}\n${command}`;

    execFile(
      '/bin/bash',
      ['-c', script],
      {
        timeout: caps.timeout_ms,
        killSignal: 'SIGKILL',
        maxBuffer: caps.max_output_bytes,
        encoding: 'utf8',
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        // timed_out is OUR timer's kill only (Node sets killed=true when
        // it sent the killSignal). A SIGKILL from ulimit enforcement
        // reaches the callback with signal set but killed=false — that
        // is a mechanical cap firing, not the wall-clock timeout, and
        // the distinction is legible in the result shape.
        const timed_out = err?.killed === true;
        let exit_code: number | null = null;
        if (err === undefined || err === null) exit_code = 0;
        else if (typeof (err as { code?: unknown }).code === 'number') {
          exit_code = (err as { code: number }).code;
        }
        // signal kills and non-numeric codes (maxBuffer exceeded, spawn
        // failure): exit_code stays null
        const sections: string[] = [];
        if (stdout) sections.push(stdout);
        if (stderr) sections.push(stdout ? `--- stderr ---\n${stderr}` : stderr);
        const raw = sections.join(stdout && stderr ? '\n' : '');
        resolve({
          exit_code,
          timed_out,
          output: truncateOutput(raw, caps.max_output_bytes),
        });
      },
    );
  });

/**
 * Match gate for a firing. No match pattern → the firing injects.
 * A match pattern is a regex against the combined output; an invalid
 * regex fails CLOSED (no injection — output is still recorded in
 * last_output, so the sensor stays legible). CRUD validates regexes at
 * write time, so this branch is defensive only.
 */
export const evaluateMatch = (match: string | null | undefined, output: string): boolean => {
  if (match === null || match === undefined) return true;
  try {
    return new RegExp(match).test(output);
  } catch {
    return false;
  }
};
