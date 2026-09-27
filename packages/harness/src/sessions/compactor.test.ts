import { test } from 'node:test';
import assert from 'node:assert';
import { dropMedia } from './compactor.js';
import { type Message } from '../types/messages.js';

test('image with caption becomes a text marker keeping the caption', () => {
  const message: Message = {
    role: 'user',
    type: 'input',
    blocks: [
      { type: 'text', text: 'look at this' },
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=', caption: 'the headboard' },
    ],
  };
  const flat = dropMedia(message);
  assert.notEqual(flat, message);
  assert.equal(flat.type, 'input');
  const blocks = (flat as Extract<Message, { type: 'input' }>).blocks;
  assert.equal(blocks[0], message.blocks[0]);
  assert.equal(blocks[1].type, 'text');
  assert.equal(blocks[1].type === 'text' && blocks[1].text, '[image dropped at compaction: image/png] the headboard');
  // The binary payload must be gone, not merely unreferenced.
  assert.ok(!JSON.stringify(flat).includes('aGVsbG8='));
});

test('image without caption keeps only the declared marker', () => {
  const message: Message = {
    role: 'user',
    type: 'input',
    blocks: [{ type: 'image', mimeType: 'image/jpeg', data: 'eA==' }],
  };
  const flat = dropMedia(message);
  const blocks = (flat as Extract<Message, { type: 'input' }>).blocks;
  assert.equal(blocks[0].type === 'text' && blocks[0].text, '[image dropped at compaction: image/jpeg]');
});

test('voice with transcription keeps the transcript as text', () => {
  const message: Message = {
    role: 'user',
    type: 'input',
    blocks: [{
      type: 'voice',
      path: 'media/telegram/note.ogg',
      mimeType: 'audio/ogg',
      duration: 12,
      transcription: 'ciao Sage',
      data: 'YXVkaW8=',
      dataFormat: 'wav',
    }],
  };
  const flat = dropMedia(message);
  const blocks = (flat as Extract<Message, { type: 'input' }>).blocks;
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[0].type === 'text' && blocks[0].text,
    '[voice note transcript, 12s, audio dropped at compaction]: ciao Sage');
  assert.ok(!JSON.stringify(flat).includes('YXVkaW8='));
});

test('voice without transcription falls back to path and duration', () => {
  const message: Message = {
    role: 'user',
    type: 'input',
    blocks: [{
      type: 'voice',
      path: 'media/telegram/mute.ogg',
      mimeType: 'audio/ogg',
      duration: 3,
    }],
  };
  const flat = dropMedia(message);
  const blocks = (flat as Extract<Message, { type: 'input' }>).blocks;
  assert.equal(blocks[0].type === 'text' && blocks[0].text,
    '[voice note dropped at compaction: media/telegram/mute.ogg, 3s]');
});

test('tool result media is flattened inside results', () => {
  const message: Message = {
    role: 'user',
    type: 'tool_res',
    results: [{
      req_id: 'r1',
      tool: 'file_read',
      blocks: [{ type: 'image', mimeType: 'image/png', data: 'cG5n' }],
    }],
  };
  const flat = dropMedia(message);
  assert.notEqual(flat, message);
  const results = (flat as Extract<Message, { type: 'tool_res' }>).results;
  assert.equal(results[0].blocks[0].type, 'text');
  assert.ok(!JSON.stringify(flat).includes('cG5n'));
});

test('media-free messages keep their reference (identity signals no-op)', () => {
  const text_only: Message = {
    role: 'user',
    type: 'input',
    blocks: [{ type: 'text', text: 'plain' }],
  };
  const legacy_requests: Message = {
    role: 'agent',
    type: 'tool_req',
    requests: [{ req_id: 'q1', tool: 'shell_exec', params: { command: 'ls' } }],
  };
  assert.equal(dropMedia(text_only), text_only);
  assert.equal(dropMedia(legacy_requests), legacy_requests);
});

test('text blocks sit beside dropped media untouched', () => {
  const message: Message = {
    role: 'user',
    type: 'input',
    blocks: [
      { type: 'text', text: 'before' },
      { type: 'image', mimeType: 'image/png', data: 'eA==' },
      { type: 'text', text: 'after' },
    ],
  };
  const flat = dropMedia(message);
  const blocks = (flat as Extract<Message, { type: 'input' }>).blocks;
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0], message.blocks[0]);
  assert.equal(blocks[2], message.blocks[2]);
  assert.equal(blocks[1].type, 'text');
});