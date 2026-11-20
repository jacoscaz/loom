import { test } from 'node:test';
import assert from 'node:assert';
import { decodeJson, encodeJson } from './json.js';

test('round-trips nested Buffers compactly', () => {
  const value = { blocks: [{ type: 'data', mime: 'image/png', data: Buffer.from('hello') }], n: 1, s: 'x', nil: null };
  const encoded = encodeJson(value);
  assert.ok(encoded.includes('"$buffer":"aGVsbG8="'), encoded);
  assert.deepStrictEqual(decodeJson(encoded), value);
});

test('leaves ordinary objects alone', () => {
  const value = { $buffer: 'not-alone', other: 1 };
  assert.deepStrictEqual(decodeJson(encodeJson(value)), value);
  assert.deepStrictEqual(decodeJson(encodeJson([1, 'two', { three: 3 }])), [1, 'two', { three: 3 }]);
});
