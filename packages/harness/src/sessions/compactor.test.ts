import { test } from "node:test";
import assert from "node:assert";
import { Message } from "../types/messages.js";
import { dropMedia } from "./compactor.js";

const imageBlock = (caption?: string) => ({
  type: 'image' as const,
  mimeType: 'image/png',
  data: 'aGVsbG8gd29ybGQ=',
  ...(caption !== undefined ? { caption } : {}),
});

const voiceBlock = (transcription?: string) => ({
  type: 'voice' as const,
  path: '/media/telegram/abc.ogg',
  mimeType: 'audio/ogg',
  duration: 12,
  ...(transcription !== undefined ? { transcription } : {}),
});

test('dropMedia replaces a captioned image with a text marker keeping the caption', () => {
  const msg: Message = {
    role: 'user',
    type: 'input',
    blocks: [
      { type: 'text', text: 'look at this' },
      imageBlock('a screenshot of the dashboard'),
    ],
  };
  const out = dropMedia(msg);
  assert.notStrictEqual(out, msg);
  if (out.type !== 'input' || out.role !== 'user') throw new Error('unexpected shape');
  assert.equal(out.blocks.length, 2);
  assert.equal(out.blocks[0].type, 'text');
  const marker = out.blocks[1];
  assert.equal(marker.type, 'text');
  if (marker.type !== 'text') throw new Error('unexpected shape');
  assert.equal(marker.text, '[image dropped by compaction: image/png] a screenshot of the dashboard');
  // the binary payload must be gone
  assert.equal(JSON.stringify(out).includes('aGVsbG8'), false);
});

test('dropMedia replaces a caption-less image with a marker carrying the mimeType', () => {
  const msg: Message = {
    role: 'user',
    type: 'input',
    blocks: [imageBlock()],
  };
  const out = dropMedia(msg);
  if (out.type !== 'input' || out.role !== 'user') throw new Error('unexpected shape');
  assert.equal(out.blocks.length, 1);
  const marker = out.blocks[0];
  if (marker.type !== 'text') throw new Error('unexpected shape');
  assert.equal(marker.text, '[image dropped by compaction: image/png]');
});

test('dropMedia keeps voice transcriptions as text', () => {
  const msg: Message = {
    role: 'user',
    type: 'input',
    blocks: [voiceBlock('remind me to merge the branch tomorrow')],
  };
  const out = dropMedia(msg);
  if (out.type !== 'input' || out.role !== 'user') throw new Error('unexpected shape');
  const marker = out.blocks[0];
  if (marker.type !== 'text') throw new Error('unexpected shape');
  assert.equal(
    marker.text,
    '[voice note dropped by compaction: /media/telegram/abc.ogg, 12s] transcription: remind me to merge the branch tomorrow',
  );
  assert.equal(JSON.stringify(out).includes('audio/ogg'), false);
});

test('dropMedia marks untranscribed voice notes by path and duration', () => {
  const msg: Message = {
    role: 'user',
    type: 'input',
    blocks: [voiceBlock()],
  };
  const out = dropMedia(msg);
  if (out.type !== 'input' || out.role !== 'user') throw new Error('unexpected shape');
  const marker = out.blocks[0];
  if (marker.type !== 'text') throw new Error('unexpected shape');
  assert.equal(marker.text, '[voice note dropped by compaction: /media/telegram/abc.ogg, 12s]');
});

test('dropMedia leaves agent input untouched and returns the same reference', () => {
  const msg: Message = {
    role: 'agent',
    type: 'input',
    blocks: [
      { type: 'text', text: 'checking now.' },
      { type: 'tool_req', req_id: 'req-1', tool: 'shell_exec', params: { command: 'ls' } },
    ],
  };
  const out = dropMedia(msg);
  assert.strictEqual(out, msg);
});

test('dropMedia returns the same reference when no media is present', () => {
  const msg: Message = {
    role: 'user',
    type: 'input',
    blocks: [{ type: 'text', text: 'plain text' }],
  };
  assert.strictEqual(dropMedia(msg), msg);
});

test('dropMedia flattens media inside tool results, preserving result identity', () => {
  const msg: Message = {
    role: 'user',
    type: 'tool_res',
    results: [
      {
        req_id: 'req-1',
        tool: 'shell_exec',
        blocks: [{ type: 'text', text: 'done' }],
      },
      {
        req_id: 'req-2',
        tool: 'file_read',
        blocks: [imageBlock('rendered preview'), { type: 'text', text: 'see above' }],
      },
    ],
  };
  const out = dropMedia(msg);
  assert.notStrictEqual(out, msg);
  if (out.type !== 'tool_res') throw new Error('unexpected shape');
  assert.equal(out.results.length, 2);
  // unchanged result keeps its reference
  assert.strictEqual(out.results[0], msg.results[0]);
  assert.equal(out.results[0].req_id, 'req-1');
  const mapped = out.results[1];
  assert.equal(mapped.req_id, 'req-2');
  assert.equal(mapped.blocks[0].type, 'text');
  if (mapped.blocks[0].type !== 'text') throw new Error('unexpected shape');
  assert.equal(mapped.blocks[0].text, '[image dropped by compaction: image/png] rendered preview');
  assert.equal(mapped.blocks[1].type, 'text');
});

test('dropMedia flattens media inside notifications', () => {
  const msg: Message = {
    role: 'user',
    type: 'notification',
    method: 'message/incoming',
    transport: { type: 'telegram', from_id: 1, chat_id: 2 },
    blocks: [voiceBlock('hello from the voice note')],
  };
  const out = dropMedia(msg);
  if (out.type !== 'notification') throw new Error('unexpected shape');
  const marker = out.blocks[0];
  if (marker.type !== 'text') throw new Error('unexpected shape');
  assert.equal(
    marker.text,
    '[voice note dropped by compaction: /media/telegram/abc.ogg, 12s] transcription: hello from the voice note',
  );
});
