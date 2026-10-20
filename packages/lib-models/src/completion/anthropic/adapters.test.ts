import { test } from "node:test";
import assert from "node:assert";
import type Anthropic from '@anthropic-ai/sdk';
import { type Message, type ProjectOptions, type TextBlock, projectMessages } from "@loom/proto";
import { parseMessage } from "./parsers.js";
import { formatMessages, type AnthropicFormatOpts } from "./formatters.js";

/**
 * Adapter-level guarantees for the Anthropic Messages API, ported from the
 * harness adapter tests to the lib-proto block model:
 * - strict user/assistant alternation via merging of same-role runs;
 * - unsupported response content is kept loudly;
 * - thinking replays only when kept by projection AND signed;
 * - the rolling cache breakpoint lands on the conversation tail.
 */

const text = (data: string): TextBlock => ({ type: 'data', mime: 'text/plain', data });

const CACHED: AnthropicFormatOpts = { prompt_cache_ttl: '1h' };
const UNCACHED: AnthropicFormatOpts = { prompt_cache_ttl: 'off' };

const PROJECTION: ProjectOptions = {
  max_text_length: Infinity,
  exclude_thinking: true,
  thinking_redacted_policy: 'placeholder',
  exclude_tool_traffic: false,
  image_policy: 'placeholder',
  audio_policy: 'placeholder',
};

const REPLAY_PROJECTION: ProjectOptions = { ...PROJECTION, exclude_thinking: false };

const format = (history: Message[], projection = PROJECTION, opts = UNCACHED) => {
  return formatMessages(projectMessages(history, projection), opts) as unknown as { role: string, content: any[] }[];
};

const asResponse = (content: unknown[]) => ({
  id: 'msg', role: 'assistant', content, usage: { input_tokens: 1, output_tokens: 1 },
}) as unknown as Anthropic.Message;

// ---------------------------------------------------------------- parsers

test('parseMessage: text and tool_use blocks become ONE agent message', () => {
  const messages = parseMessage(asResponse([
    { type: 'text', text: 'Checking now.' },
    { type: 'tool_use', id: 'toolu_1', name: 'shell_exec', input: { command: 'ls' } },
    { type: 'tool_use', id: 'toolu_2', name: 'file_read', input: { path: '/a' } },
  ]));
  assert.equal(messages.length, 1);
  assert.deepStrictEqual(messages[0], {
    role: 'agent',
    blocks: [
      text('Checking now.'),
      { type: 'tool_call', call_id: 'toolu_1', tool: 'shell_exec', params: { command: 'ls' } },
      { type: 'tool_call', call_id: 'toolu_2', tool: 'file_read', params: { path: '/a' } },
    ],
  });
});

test('parseMessage: thinking keeps its signature, redacted thinking keeps its place', () => {
  const messages = parseMessage(asResponse([
    { type: 'thinking', thinking: 'private reasoning', signature: 'sig-abc' },
    { type: 'redacted_thinking', data: 'encrypted' },
    { type: 'text', text: 'answer' },
  ]));
  assert.deepStrictEqual(messages[0]!.blocks, [
    { type: 'thinking', text: 'private reasoning', anthropic_signature: 'sig-abc' },
    { type: 'thinking_redacted', text: '' },
    text('answer'),
  ]);
});

test('parseMessage: server-side blocks are captured loudly, not dropped', () => {
  const messages = parseMessage(asResponse([
    { type: 'text', text: 'ok' },
    { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} },
  ]));
  const unsupported = (messages[0]!.blocks[1] as TextBlock).data!;
  assert.ok(unsupported.startsWith('[unsupported] [content block: server_tool_use]'), unsupported);
});

test('parseMessage: empty text blocks are skipped, an empty response yields no message', () => {
  assert.deepStrictEqual(parseMessage(asResponse([{ type: 'text', text: '' }])), []);
});

// ------------------------------------------------------------- formatters

test('formatMessages: a native turn projects as ONE assistant message', () => {
  const wire = format([
    { role: 'user', blocks: [text('run it')] },
    {
      role: 'agent',
      blocks: [
        text('Running.'),
        { type: 'thinking', text: 'stripped: not kept by projection' },
        { type: 'tool_call', call_id: 'toolu_9', tool: 'shell_exec', params: { command: 'ls' } },
      ],
    },
  ]);
  assert.equal(wire.length, 2);
  assert.deepStrictEqual(wire[1], {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Running.' },
      { type: 'tool_use', id: 'toolu_9', name: 'shell_exec', input: { command: 'ls' } },
    ],
  });
});

test('formatMessages: consecutive same-role messages merge, preserving block order', () => {
  const wire = format([
    { role: 'user', blocks: [{ type: 'envelope', kind: 'message', from: 'telegram:42', blocks: [text('hello')] }] },
    { role: 'user', blocks: [text('there')] },
    { role: 'agent', blocks: [text('Running.')] },
    { role: 'agent', blocks: [{ type: 'tool_call', call_id: 't', tool: 'x', params: {} }] },
  ]);
  assert.equal(wire.length, 2);
  assert.deepStrictEqual(wire[0]!.content.map(b => b.text), ['[message from telegram:42]', 'hello', 'there']);
  assert.deepStrictEqual(wire[1]!.content.map(b => b.type), ['text', 'tool_use']);
});

test('formatMessages: tool responses become tool_result blocks, ordered first', () => {
  const wire = format([
    { role: 'agent', blocks: [{ type: 'tool_call', call_id: 'toolu_5', tool: 'shell_exec', params: {} }] },
    { role: 'user', blocks: [text('meanwhile'), { type: 'tool_resp', call_id: 'toolu_5', response: [text('file-a')] }] },
  ]);
  assert.deepStrictEqual(wire[1]!.content, [
    { type: 'tool_result', tool_use_id: 'toolu_5', content: [{ type: 'text', text: 'file-a' }] },
    { type: 'text', text: 'meanwhile' },
  ]);
});

test('formatMessages: the rolling cache breakpoint lands on the tail, even a tool_result', () => {
  const wire = format([
    { role: 'user', blocks: [text('go')] },
    { role: 'agent', blocks: [{ type: 'tool_call', call_id: 'toolu_5', tool: 'shell_exec', params: {} }] },
    { role: 'user', blocks: [{ type: 'tool_resp', call_id: 'toolu_5', response: [text('out')] }] },
  ], PROJECTION, CACHED);
  const all = wire.flatMap(m => m.content);
  assert.equal(all.filter(b => b.cache_control).length, 1, 'exactly one breakpoint in the conversation');
  const tail = wire[2]!.content.at(-1)!;
  assert.equal(tail.type, 'tool_result');
  assert.deepStrictEqual(tail.cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('formatMessages: no breakpoints when caching is off', () => {
  const wire = format([{ role: 'user', blocks: [text('go')] }]);
  assert.equal(wire[0]!.content[0].cache_control, undefined);
});

test('formatMessages: unsigned thinking is stripped even when projection keeps it', () => {
  const wire = format([
    { role: 'user', blocks: [text('go')] },
    { role: 'agent', blocks: [{ type: 'thinking', text: 'unsigned' }, text('the answer')] },
  ], REPLAY_PROJECTION);
  assert.deepStrictEqual(wire[1]!.content, [{ type: 'text', text: 'the answer' }]);
});

test('formatMessages: signed thinking replays when projection keeps it', () => {
  const wire = format([
    { role: 'user', blocks: [text('go')] },
    { role: 'agent', blocks: [{ type: 'thinking', text: 'reasoned', anthropic_signature: 'sig-1' }, text('the answer')] },
  ], REPLAY_PROJECTION);
  assert.deepStrictEqual(wire[1]!.content[0], { type: 'thinking', thinking: 'reasoned', signature: 'sig-1' });
});

test('formatMessages: images are withheld as marked text when vision is unsupported', () => {
  const wire = format([{
    role: 'user',
    blocks: [{ type: 'data', mime: 'image/png', data: Buffer.from('PNG'), caption: text('a photo') }, text('what is this?')],
  }]);
  assert.deepStrictEqual(wire[0]!.content, [
    { type: 'text', text: '[image omitted: image/png] a photo' },
    { type: 'text', text: 'what is this?' },
  ]);
});

test('formatMessages: kept images become base64 or url image sources', () => {
  const wire = format([{
    role: 'user',
    blocks: [
      { type: 'data', mime: 'image/png', data: Buffer.from('PNG'), caption: text('a photo') },
      { type: 'data', mime: 'image/webp', url: 'https://example.com/a.webp' },
    ],
  }], { ...PROJECTION, image_policy: 'keep' });
  assert.deepStrictEqual(wire[0]!.content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('PNG').toString('base64') } },
    { type: 'text', text: 'a photo' },
    { type: 'image', source: { type: 'url', url: 'https://example.com/a.webp' } },
  ]);
});

test('formatMessages: audio is a projection leak (the API has no audio input)', () => {
  assert.throws(
    () => format([{ role: 'user', blocks: [{ type: 'data', mime: 'audio/wav', data: Buffer.from('x') }] }], { ...PROJECTION, audio_policy: 'keep' }),
    /upstream projection leaked/,
  );
});
