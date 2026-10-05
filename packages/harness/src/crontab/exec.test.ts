
import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { evaluateMatch, executeHook, truncateOutput, DEFAULT_HOOK_CAPS } from './exec.js';

test('executeHook captures output and exit code', async () => {
  const r = await executeHook('echo hello; echo err >&2', DEFAULT_HOOK_CAPS);
  assert.strictEqual(r.exit_code, 0);
  assert.strictEqual(r.timed_out, false);
  assert.ok(r.output.includes('hello'));
  assert.ok(r.output.includes('err'));
});

test('executeHook reports non-zero exit codes', async () => {
  const r = await executeHook('exit 3', DEFAULT_HOOK_CAPS);
  assert.strictEqual(r.exit_code, 3);
});

test('executeHook enforces the wall-clock timeout (SIGKILL)', async () => {
  const r = await executeHook('sleep 30', { timeout_ms: 500, max_output_bytes: 8192 });
  assert.strictEqual(r.timed_out, true);
  assert.strictEqual(r.exit_code, null);
});

test('executeHook applies the file-size ulimit (mechanical cap, not in the command)', async () => {
  // The command is never touched by the caps — they live in the runner's
  // invocation. A writer exceeding ulimit -f (file_blocks = ceil(
  // max_output_bytes*4/1024) = 32 blocks = 32768 bytes here) is killed
  // by SIGXFSZ — NOT by our wall-clock timer.
  const path = `/tmp/loom-crontab-ulimit-test-${process.pid}.bin`;
  const r = await executeHook(`yes > ${path}`, { timeout_ms: 15000, max_output_bytes: 8192 });
  try {
    assert.strictEqual(r.timed_out, false);
    // SIGXFSZ kill: bash reports 128+31, or null if the signal surfaced
    // differently — the proof is the capped file, not the code.
    assert.ok(r.exit_code === null || r.exit_code >= 128, `exit_code ${r.exit_code}`);
    const size = existsSync(path) ? statSync(path).size : -1;
    assert.ok(size >= 0, 'the test file should exist');
    assert.ok(size <= 32768 + 4096, `file size ${size} exceeds the ulimit -f cap`);
  } finally {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
});

test('evaluateMatch: null matches everything, regex gates on output', () => {
  assert.strictEqual(evaluateMatch(null, ''), true);
  assert.strictEqual(evaluateMatch(undefined, 'anything'), true);
  assert.strictEqual(evaluateMatch('coord', 'some output mentioning coord'), true);
  assert.strictEqual(evaluateMatch('coord', 'unrelated output'), false);
  // JS semantics: `$` anchors at end of input (no Python-style implicit
  // pre-trailing-newline match without /m).
  assert.strictEqual(evaluateMatch('^exit 0$', 'exit 0'), true);
  assert.strictEqual(evaluateMatch('^exit 0$', 'exit 0\n'), false);
});

test('evaluateMatch fails closed on invalid regex (defensive; CRUD validates)', () => {
  assert.strictEqual(evaluateMatch('([unclosed', 'anything'), false);
});

test('truncateOutput respects the byte budget and backtracks UTF-8 safely', () => {
  const ascii = 'a'.repeat(100);
  const cutAscii = truncateOutput(ascii, 50);
  // The budget reserves room for the marker: capped output fits the cap.
  assert.ok(cutAscii.length < 50);
  assert.ok(cutAscii.endsWith('…[truncated]'));

  const multi = '€'.repeat(100); // 3 bytes each, 300 bytes
  const cut = truncateOutput(multi, 100);
  assert.ok(Buffer.byteLength(cut, 'utf8') <= 100);
  // The cut lands on a code-point boundary — never a lone continuation byte.
  const body = cut.slice(0, cut.indexOf('\n…'));
  assert.ok(!/\uFFFD/.test(Buffer.from(body, 'utf8').toString('utf8')), 'no replacement chars: cut was on a boundary');
});

test('truncateOutput is a no-op under the cap', () => {
  const s = 'hello world';
  assert.strictEqual(truncateOutput(s, DEFAULT_HOOK_CAPS.max_output_bytes), s);
});
