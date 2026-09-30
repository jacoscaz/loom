// Unit tests for sniffImageMime — the magic-byte sniffer backing the
// image-normalization mime fix (2026-09-30). The passthrough path in
// normalizeImage returns original bytes of any format; the declared
// mimeType must match the actual bytes or Anthropic's API rejects the
// activation (base64/media_type coherence validation).

import { test } from 'node:test';
import assert from 'node:assert';
import { sniffImageMime } from './files.js';

test('sniffImageMime recognizes JPEG magic bytes', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  assert.strictEqual(sniffImageMime(jpeg), 'image/jpeg');
});

test('sniffImageMime recognizes PNG magic bytes', () => {
  // The exact case that broke Opus activations: small PNG passed through
  // declared as image/jpeg.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  assert.strictEqual(sniffImageMime(png), 'image/png');
});

test('sniffImageMime recognizes WEBP (RIFF....WEBP)', () => {
  const webp = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x24, 0x08, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
    Buffer.from('VP8 ', 'ascii'),
  ]);
  assert.strictEqual(sniffImageMime(webp), 'image/webp');
});

test('sniffImageMime recognizes both GIF variants', () => {
  assert.strictEqual(sniffImageMime(Buffer.from('GIF87a', 'ascii')), 'image/gif');
  assert.strictEqual(sniffImageMime(Buffer.from('GIF89a', 'ascii')), 'image/gif');
});

test('sniffImageMime falls back to image/jpeg on unknown bytes', () => {
  // Matches the historical default and the recompress path, which always
  // produces real JPEGs via sharp.
  assert.strictEqual(sniffImageMime(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06])), 'image/jpeg');
});

test('sniffImageMime does not throw on short buffers', () => {
  assert.strictEqual(sniffImageMime(Buffer.from([0xff])), 'image/jpeg');
  assert.strictEqual(sniffImageMime(Buffer.alloc(0)), 'image/jpeg');
});
