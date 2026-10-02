import { test } from "node:test";
import assert from "node:assert";
import { sanitizeText, sanitizeDeep } from "./sanitize.js";
import { projectMessage } from "./projection.js";
import { PROJECT_COMPACTION_OPTS } from "./projection.js";
import { Message, UserInput, AgentToolRequest } from "./types/messages.js";
import { TextBlock, ImageBlock } from "./types/blocks.js";

/**
 * UTF8 guard tests, from the 2026-10-02 incident: an inbound message
 * carrying lone surrogates reached JSONB as \udXXX escapes and crashed
 * the activation loop. The invariant under test: nothing entering the
 * weave (persistence or projection) may contain lone surrogates or NUL;
 * valid content — paired surrogates included — passes byte-identical.
 */

const LONE_HIGH = '\uD800';
const LONE_LOW = '\uDC00';
const PAIRED = '\uD83D\uDE00'; // 😀 — valid surrogate pair, must survive
const DIRTY_TEXT = `before ${LONE_HIGH} mid ${LONE_LOW} after`;
const CLEAN_TEXT = `hello ${PAIRED} world`;

const isClean = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0000 || (c >= 0xD800 && c <= 0xDFFF)) return false;
  }
  return true;
};

test('sanitizeText replaces lone surrogates with U+FFFD', () => {
  const out = sanitizeText(DIRTY_TEXT);
  assert.ok(isClean(out), 'output must contain no surrogates');
  assert.strictEqual(out, `before \uFFFD mid \uFFFD after`);
});

test('sanitizeText replaces NUL with U+FFFD', () => {
  const out = sanitizeText('a\u0000b');
  assert.ok(isClean(out));
  assert.strictEqual(out, 'a\uFFFDb');
});

test('sanitizeText preserves valid content byte-identical', () => {
  assert.strictEqual(sanitizeText(CLEAN_TEXT), CLEAN_TEXT);
  assert.strictEqual(sanitizeText('plain ascii'), 'plain ascii');
  assert.strictEqual(sanitizeText('àèìòù — émoji 🌿'), 'àèìòù — émoji 🌿');
});

test('sanitizeText handles adjacent and trailing lone surrogates', () => {
  const out = sanitizeText(`${LONE_HIGH}${LONE_HIGH} tail ${LONE_LOW}`);
  assert.ok(isClean(out));
  assert.strictEqual(out, '\uFFFD\uFFFD tail \uFFFD');
});

test('sanitizeDeep returns the same reference for clean values', () => {
  const obj = { a: 'clean', b: { c: [CLEAN_TEXT, 42, null, true] } };
  assert.strictEqual(sanitizeDeep(obj), obj);
});

test('sanitizeDeep sanitizes strings at depth, preserving structure', () => {
  const dirty = {
    text: DIRTY_TEXT,
    nested: { params: { q: `${LONE_LOW}x` }, arr: ['ok', DIRTY_TEXT] },
    n: 7,
    keep: null,
  };
  const out = sanitizeDeep(dirty);
  assert.notStrictEqual(out, dirty, 'dirty object must be replaced by a copy');
  assert.strictEqual(out.text, `before \uFFFD mid \uFFFD after`);
  assert.strictEqual((out.nested.params as any).q, '\uFFFDx');
  assert.strictEqual(out.nested.arr[0], 'ok');
  assert.strictEqual(out.nested.arr[1], `before \uFFFD mid \uFFFD after`);
  assert.strictEqual(out.n, 7);
  assert.strictEqual(out.keep, null);
});

test('sanitizeDeep leaves non-string leaves untouched (numbers, base64)', () => {
  const b64 = Buffer.from('binary-ish').toString('base64');
  const obj = { data: b64, size: 1024, flag: false };
  assert.strictEqual(sanitizeDeep(obj), obj);
});

test('sanitized messages are JSON-roundtrip-stable (JSONB pre-condition)', () => {
  const dirty: UserInput = {
    role: 'user',
    type: 'input',
    blocks: [{ type: 'text', text: DIRTY_TEXT } as TextBlock],
  };
  const out = sanitizeDeep(dirty);
  const round = JSON.parse(JSON.stringify(out));
  assert.deepStrictEqual(round, out, 'sanitized data must survive a JSON round-trip unchanged');
  assert.ok(isClean((out.blocks[0] as TextBlock).text));
});

test('projectMessage sanitizes legacy dirty rows on the injection path', () => {
  const dirty: UserInput = {
    role: 'user',
    type: 'input',
    blocks: [
      { type: 'text', text: `legacy ${LONE_HIGH} row` } as TextBlock,
    ],
  };
  const projected = projectMessage(dirty, PROJECT_COMPACTION_OPTS) as UserInput;
  assert.ok(projected);
  const text = (projected.blocks[0] as TextBlock).text;
  assert.ok(isClean(text), 'projected text must contain no surrogates');
  assert.strictEqual(text, `legacy \uFFFD row`);
});

test('projectMessage sanitizes tool_req params (projection-opaque but JSONB-bound)', () => {
  const dirty: AgentToolRequest = {
    role: 'agent',
    type: 'tool_req',
    requests: [{ req_id: 'r1', tool: 'some_tool', params: { q: `${LONE_LOW}` } }],
  };
  const projected = projectMessage(dirty, PROJECT_COMPACTION_OPTS);
  assert.ok(projected);
  const out = JSON.stringify(projected);
  assert.ok(!/\\ud[89ab][0-9a-f]/i.test(out), 'serialized params must contain no lone-surrogate escapes');
});

test('projectMessage passes clean image blocks through untouched (data, caption)', () => {
  const msg: UserInput = {
    role: 'user',
    type: 'input',
    blocks: [{
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from('png').toString('base64'),
      caption: CLEAN_TEXT,
    } as ImageBlock],
  };
  // Compaction profile replaces images with transcript markers — the
  // caption is content and must survive, sanitized, inside the marker.
  const projected = projectMessage(msg, PROJECT_COMPACTION_OPTS) as UserInput;
  assert.ok(projected);
  const block = projected.blocks[0] as TextBlock;
  assert.strictEqual(block.type, 'text');
  assert.strictEqual(block.text, `[image omitted: image/png] ${CLEAN_TEXT}`);

  // keep-profile: the payload itself must pass byte-identical.
  const kept = projectMessage(msg, { ...PROJECT_COMPACTION_OPTS, image_policy: 'keep' }) as UserInput;
  assert.ok(kept);
  const img = kept.blocks[0] as ImageBlock;
  assert.strictEqual(img.caption, CLEAN_TEXT);
  assert.strictEqual(img.data, (msg.blocks[0] as ImageBlock).data, 'image payload must be byte-identical');
});
