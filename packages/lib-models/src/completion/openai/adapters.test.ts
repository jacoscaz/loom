import { test } from "node:test";
import assert from "node:assert";
import type OpenAI from 'openai';
import { type Message, type ProjectOptions, type TextBlock, projectMessage, projectMessages } from "@loom/proto";
import { parseMessage } from "./parsers.js";
import { formatMessage, formatMessages, type OpenAIFormatOpts } from "./formatters.js";
import { findTextualToolCallNames } from "../shared.js";

/**
 * Adapter-level guarantees for OpenAI-compatible chat completions, ported
 * from the harness adapter tests to the lib-proto block model.
 */

const text = (data: string): TextBlock => ({ type: 'data', mime: 'text/plain', data });

const FIELD: OpenAIFormatOpts = { thinking_wire_style: 'field' };
const BLOCKS: OpenAIFormatOpts = { thinking_wire_style: 'blocks' };

const PROJECTION: ProjectOptions = {
  max_text_length: Infinity,
  exclude_thinking: true,
  thinking_redacted_policy: 'placeholder',
  exclude_tool_traffic: false,
  image_policy: 'placeholder',
  audio_policy: 'placeholder',
};

const asResponse = (m: Record<string, unknown>) => ({ role: 'assistant', refusal: null, ...m }) as unknown as OpenAI.ChatCompletionMessage;

type WireAssistant = {
  role: string;
  content?: string | Record<string, unknown>[];
  reasoning_content?: string;
  refusal?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
};

// ---------------------------------------------------------------- parsers

test('parseMessage: content, reasoning and tool_calls become ONE agent message', () => {
  const messages = parseMessage(asResponse({
    content: 'Checking now.',
    reasoning_content: 'I should list it.',
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'shell_exec', arguments: '{"command":"ls"}' } },
      { id: 'call_2', type: 'function', function: { name: 'file_read', arguments: '{"path":"/a"}' } },
    ],
  }));
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.role, 'agent');
  assert.deepStrictEqual(messages[0]!.blocks, [
    text('Checking now.'),
    { type: 'thinking', text: 'I should list it.' },
    { type: 'tool_call', call_id: 'call_1', tool: 'shell_exec', params: { command: 'ls' } },
    { type: 'tool_call', call_id: 'call_2', tool: 'file_read', params: { path: '/a' } },
  ]);
});

test('parseMessage: invalid tool call arguments degrade to empty params', () => {
  const messages = parseMessage(asResponse({
    content: null,
    tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}""' } }],
  }));
  assert.deepStrictEqual(messages[0]!.blocks, [{ type: 'tool_call', call_id: 'c', tool: 'x', params: {} }]);
});

test('parseMessage: refusals become refusal blocks', () => {
  const messages = parseMessage(asResponse({ content: null, refusal: 'I cannot help with that.' }));
  assert.deepStrictEqual(messages[0]!.blocks, [{ type: 'refusal', reason: 'I cannot help with that.' }]);
});

test('parseMessage: annotations and legacy function_call are captured loudly', () => {
  const messages = parseMessage(asResponse({
    content: 'see the link',
    annotations: [{ type: 'url_citation', url: 'https://x' }],
    function_call: { name: 'legacy', arguments: '{}' },
  }));
  const texts = messages[0]!.blocks.map(b => (b as TextBlock).data);
  assert.ok(texts.some(t => t?.startsWith('[unsupported] [annotations]')));
  assert.ok(texts.some(t => t?.startsWith('[unsupported] [legacy function_call]')));
});

test('parseMessage: an empty response yields no message', () => {
  assert.deepStrictEqual(parseMessage(asResponse({ content: null })), []);
});

test('parseMessage: Mistral block content — thinking and text chunks normalize', () => {
  const messages = parseMessage(asResponse({
    content: [
      { type: 'thinking', thinking: [{ type: 'text', text: 'step one' }, { type: 'text', text: 'step two' }], closed: true },
      { type: 'text', text: 'the ' },
      { type: 'text', text: 'answer' },
      { type: 'hologram', payload: { x: 1 } },
    ],
  }));
  const blocks = messages[0]!.blocks;
  assert.deepStrictEqual(blocks[0], { type: 'thinking', text: 'step one\nstep two' });
  assert.ok((blocks[1] as TextBlock).data!.startsWith('[unsupported] [content chunk]'));
  assert.deepStrictEqual(blocks[2], text('the answer'));
});

// ------------------------------------------------------------- formatters

test('formatMessages: a native turn projects as ONE assistant message', () => {
  const wire = formatMessages([{
    role: 'agent',
    blocks: [
      { type: 'thinking', text: 'the reasoning' },
      text('calling now'),
      { type: 'tool_call', call_id: 'r1', tool: 'shell_exec', params: { command: 'ls' } },
    ],
  }], FIELD);
  assert.equal(wire.length, 1);
  const assistant = wire[0] as WireAssistant;
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.reasoning_content, 'the reasoning');
  assert.equal(assistant.content, 'calling now');
  assert.deepStrictEqual(assistant.tool_calls, [
    { id: 'r1', type: 'function', function: { name: 'shell_exec', arguments: '{"command":"ls"}' } },
  ]);
});

test('formatMessages: a split turn (text, then bare tool calls) folds into one assistant message', () => {
  const wire = formatMessages([
    { role: 'agent', blocks: [text('calling now')] },
    { role: 'agent', blocks: [{ type: 'tool_call', call_id: 'r1', tool: 'shell_exec', params: {} }] },
  ], FIELD);
  assert.equal(wire.length, 1);
  assert.equal((wire[0] as WireAssistant).tool_calls?.length, 1);
});

test('formatMessages: tool responses become tool messages, ahead of plain user content', () => {
  const wire = formatMessages([
    { role: 'agent', blocks: [{ type: 'tool_call', call_id: 'r1', tool: 'shell_exec', params: {} }] },
    {
      role: 'user',
      blocks: [
        text('also, hello'),
        { type: 'tool_resp', call_id: 'r1', response: [text('done')] },
      ],
    },
  ], FIELD);
  assert.deepStrictEqual(wire.map(m => m.role), ['assistant', 'tool', 'user']);
  assert.deepStrictEqual(wire[1], { role: 'tool', tool_call_id: 'r1', content: [{ type: 'text', text: 'done' }] });
  assert.deepStrictEqual((wire[2] as OpenAI.ChatCompletionUserMessageParam).content, [{ type: 'text', text: 'also, hello' }]);
});

test('formatMessages: envelopes render their provenance before their content', () => {
  const wire = formatMessages([{
    role: 'user',
    blocks: [{ type: 'envelope', kind: 'message', from: 'telegram:42', blocks: [text('ping')] }],
  }], FIELD);
  assert.deepStrictEqual((wire[0] as OpenAI.ChatCompletionUserMessageParam).content, [
    { type: 'text', text: '[message from telegram:42]' },
    { type: 'text', text: 'ping' },
  ]);
});

test('formatMessage: redacted thinking replays as its projection placeholder', () => {
  const message: Message = {
    role: 'agent',
    blocks: [{ type: 'thinking_redacted', text: '' }, text('the visible answer')],
  };
  const wire = formatMessage(projectMessage(message, PROJECTION)!, FIELD);
  const assistant = wire[0] as WireAssistant;
  assert.equal(assistant.content, '[thinking redacted] the visible answer');
  assert.equal(assistant.reasoning_content, undefined);
});

test('formatMessages: refusals route to the refusal field', () => {
  const wire = formatMessages([{ role: 'agent', blocks: [{ type: 'refusal', reason: 'no' }] }], FIELD);
  assert.equal((wire[0] as WireAssistant).refusal, 'no');
});

test('formatMessages: images and their captions become image_url + text parts', () => {
  const wire = formatMessages([{
    role: 'user',
    blocks: [
      { type: 'data', mime: 'image/png', data: Buffer.from('PNG'), caption: text('a cat') },
      { type: 'data', mime: 'image/jpeg', url: 'https://example.com/a.jpg' },
    ],
  }], FIELD);
  assert.deepStrictEqual((wire[0] as OpenAI.ChatCompletionUserMessageParam).content, [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('PNG').toString('base64')}` } },
    { type: 'text', text: 'a cat' },
    { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } },
  ]);
});

test('formatMessages: kept audio projects input_audio plus a labelled transcript', () => {
  const wire = formatMessages([{
    role: 'user',
    blocks: [{
      type: 'data', mime: 'audio/wav', duration: 30, data: Buffer.from('WAV'), transcription: text('the spoken words'),
    }],
  }], FIELD);
  assert.deepStrictEqual((wire[0] as OpenAI.ChatCompletionUserMessageParam).content, [
    { type: 'input_audio', input_audio: { data: Buffer.from('WAV').toString('base64'), format: 'wav' } },
    { type: 'text', text: '[audio, 30s, audio attached]: the spoken words' },
  ]);
});

test('formatMessages: audio without data, or in a format input_audio rejects, degrades honestly', () => {
  const wire = formatMessages([{
    role: 'user',
    blocks: [
      { type: 'data', mime: 'audio/ogg', duration: 12, data: Buffer.from('OGG'), transcription: text('just text') },
      { type: 'data', mime: 'audio/wav', duration: 3 },
    ],
  }], FIELD);
  assert.deepStrictEqual((wire[0] as OpenAI.ChatCompletionUserMessageParam).content, [
    { type: 'text', text: '[audio, 12s, audio unavailable]: just text' },
    { type: 'text', text: '[audio, 3s, audio unavailable, no transcription]' },
  ]);
});

test('formatMessages: non-text data in an agent message is a projection leak', () => {
  assert.throws(
    () => formatMessages([{ role: 'agent', blocks: [{ type: 'data', mime: 'image/png', data: Buffer.from('x') }] }], FIELD),
    /upstream projection leaked/,
  );
});

test('thinking_wire_style blocks: thinking + text replay as a Mistral chunk list', () => {
  const wire = formatMessages([{
    role: 'agent',
    blocks: [{ type: 'thinking', text: 'deep thought' }, text('the answer')],
  }], BLOCKS);
  const assistant = wire[0] as WireAssistant;
  assert.equal(assistant.reasoning_content, undefined, 'reasoning_content is rejected on input by Mistral');
  assert.deepStrictEqual(assistant.content, [
    { type: 'thinking', thinking: [{ type: 'text', text: 'deep thought' }], closed: true },
    { type: 'text', text: 'the answer' },
  ]);
});

test('thinking_wire_style blocks: tool-call turns fall back to plain string content', () => {
  const wire = formatMessages([{
    role: 'agent',
    blocks: [
      { type: 'thinking', text: 'deep thought' },
      text('calling'),
      { type: 'tool_call', call_id: 'r1', tool: 'x', params: {} },
    ],
  }], BLOCKS);
  const assistant = wire[0] as WireAssistant;
  assert.equal(assistant.content, 'calling');
  assert.equal(assistant.tool_calls?.length, 1);
});

test('round trip: a native turn survives parse -> project -> format with its grouping intact', () => {
  const [turn] = parseMessage(asResponse({
    content: 'Running.',
    reasoning_content: 'plan',
    tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'shell_exec', arguments: '{"command":"ls"}' } }],
  }));
  const history: Message[] = [
    turn!,
    { role: 'user', blocks: [{ type: 'tool_resp', call_id: 'call_9', response: [text('a.txt')] }] },
  ];
  const wire = formatMessages(projectMessages(history, { ...PROJECTION, exclude_thinking: false }), FIELD);
  assert.deepStrictEqual(wire.map(m => m.role), ['assistant', 'tool']);
  const assistant = wire[0] as WireAssistant;
  assert.equal(assistant.content, 'Running.');
  assert.equal(assistant.reasoning_content, 'plan');
  assert.equal(assistant.tool_calls?.[0]?.id, 'call_9');
  assert.equal((wire[1] as OpenAI.ChatCompletionToolMessageParam).tool_call_id, 'call_9');
});

// ------------------------------------------------------- textual tool calls

test('findTextualToolCallNames: call-like forms match, prose does not', () => {
  const tools = ['continuity_append', 'shell_exec'];
  assert.deepStrictEqual(findTextualToolCallNames('<continuity_append<arg_key>id</arg_key>', tools), ['continuity_append']);
  assert.deepStrictEqual(findTextualToolCallNames('{"name": "shell_exec", "arguments": {}}', tools), ['shell_exec']);
  assert.deepStrictEqual(findTextualToolCallNames('I will use shell_exec to list files.', tools), []);
});
