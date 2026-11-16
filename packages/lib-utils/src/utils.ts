
import { exec, ExecOptions, ExecOptionsWithBufferEncoding, ExecOptionsWithStringEncoding } from 'node:child_process';

// import { ValidationErrorItem } from '@runtyped/type';
// import { tmpdir } from 'node:os';
import { AddressInfo } from 'node:net';

export const runAsyncMain = async (fn: () => Promise<void>) => {
    try {
        await fn();
    } catch (error) {
        // Stdout is reserved for the session-stream mirror in the harness;
        // startup failures of CLI entry points go to stderr.
        process.stderr.write(`${String(error)}\n`);
        process.exit(1);
    }
};

// export const validationErrsToString = (errs: ValidationErrorItem[]): string => {
export const validationErrsToString = (errs: { path: string; message: string; }[]): string => {
  return errs.map(err => `${err.path}: ${err.message}`).join(', ');
};

export class Deferred<T> {
    promise: Promise<T>;
    resolve!: (value: T | PromiseLike<T>) => void;
    reject!: (reason?: any) => void;
    constructor() {
      this.promise = new Promise<T>((resolve, reject) => {
          this.resolve = resolve;
          this.reject = reject;
      });
    }
}

export const errToString = (err: Error | any, hide_stack?: boolean): string => {
  if (err instanceof Error) {
    return hide_stack ? err.message : (err.stack ?? err.message);
  }
  if (typeof err === 'object' && err !== 'null') {
    return Object.prototype.toString.call(err.message ?? err);
  }
  return Object.prototype.toString.call(err);
};

export const setMap = <I, O>(set: Set<I>, fn: (item: I) => O): O[] => {
  const res: O[] = new Array(set.size);
  let idx = 0;
  set.forEach((item) => {
    res[idx++] = fn(item);
  });
  return res;
};

export async function execAsync(command: string, opts?: ExecOptionsWithStringEncoding): Promise<{ stdout: string, stderr: string }>;
export async function execAsync(command: string, opts?: ExecOptionsWithBufferEncoding): Promise<{stdout: Buffer, stderr: Buffer }>;
export async function execAsync(command: string, opts?: ExecOptions): Promise<{stdout: string | Buffer, stderr: string | Buffer }> {
  return new Promise((resolve, reject) => {
    exec(command, opts, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export const wait = async (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Polls `fn` until it returns a truthy value or the timeout expires.
 * ProcessManager has no "ready" signal, so tests wait on observable state.
 */
export const waitFor = async <T>(fn: () => T, timeout_ms = 2_000, interval_ms = 10): Promise<NonNullable<T>> => {
  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval_ms));
  }
  throw new Error(`waitFor: condition not met within ${timeout_ms}ms`);
};

export const ellipsis = (str: string, length: number, suffix: string = '...'): string => {
  return str.length > length ? str.substring(0, length) + suffix : str;
};

/**
 * Builds a preview windowed around the first case-insensitive occurrence
 * of `term` in `str`, with the match wrapped in `mark`. Falls back to a
 * head `ellipsis(str, fallbackLength)` when the term is not present.
 * Designed for search previews: the interesting content of a long record
 * is wherever the query matched, not at char 0.
 */
export const ellipsisAround = (
  str: string,
  term: string,
  fallbackLength: number,
  window: number = 150,
  suffix: string = '...',
  mark: [string, string] = ['**', '**'],
): string => {
  const trimmed = term.trim();
  if (trimmed.length === 0) return ellipsis(str, fallbackLength, suffix);
  const idx = str.toLowerCase().indexOf(trimmed.toLowerCase());
  if (idx === -1) return ellipsis(str, fallbackLength, suffix);
  const start = Math.max(0, idx - window);
  const end = Math.min(str.length, idx + trimmed.length + window);
  const prefix = start > 0 ? suffix : '';
  const postfix = end < str.length ? suffix : '';
  return `${prefix}${str.substring(start, idx)}${mark[0]}${str.substring(idx, idx + trimmed.length)}${mark[1]}${str.substring(idx + trimmed.length, end)}${postfix}`;
};

// AddressInfo
// string | AddressInfo
//
export const addressInfoToString = (info: string | AddressInfo): string => {
  if (typeof info === 'string') {
    return info;
  }
  return `${info.address}:${info.port}`;
};

export const pick = <T extends {}, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> => {
  return keys.reduce((acc, key) => {
    if (key in obj && Object.prototype.hasOwnProperty.call(obj, key)) {
      acc[key] = obj[key];
    }
    return acc;
  }, Object.create(null) as Pick<T, K>);
};
