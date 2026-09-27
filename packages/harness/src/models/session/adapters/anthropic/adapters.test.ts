import { test } from "node:test";
import assert from "node:assert";
import type Anthropic from '@anthropic-ai/sdk';
import { parseMessage } from "./parsers.js";
import { formatMessages } from "./formatters.js";
import { projectMessages } from "../../../../projection.js";
import { type AnthropicSessionModel } from "./anthropic.js";
import { type AgentInput, type Message } from "../../../../types/messages.js";

/**
 * Adapter-level guarantees for the Anthropic Messages API:
 * - strict user/assistant alternation via merging of same-role runs;
 * - unsupported response content is kept (as unsupported blocks), and
 *   unsupported stored content replays as loud marked text;
 * - thinking blocks are stripped unless replay is enabled AND a
 *   signature was persisted (unsigned history must never reject);
 * - cache breakpoints land on the conversation tail, never on a
 *   tool_result block.
 */

const FAKE_ADAPTER = {
  replay_thinking: false,
  supports_image_input: false,
  prompt_cache_ttl: '1h',
  // The adapter's content decisions now come from its projection profile.
  projection: {
    max_text_length: Infinity,
    exclude_thinking: true,
    thinking_redacted_policy: 'placeholder',
    exclude_tool_traffic: false,
    image_policy: 'placeholder',
    voice_policy: 'placeholder',
  },
} as unknown as AnthropicSessionModel;

const asMessage = (m: Anthropic.Message): Anthropic.Message => m;

test('parseMessage: tool_use blocks become tool_req blocks within the AgentInput', () => {
  const response = asMessage({
    id: 'msg_1',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Checking now.' },
      { type: 'tool_use', id: 'toolu_1', name: 'shell_exec', input: { command: 'ls' } },
      { type: 'tool_use', id: 'toolu_2', name: 'file_read', input: { path: '/a' } },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message);

  const messages = parseMessage(response);
  assert.equal(messages.length, 1, 'one canonical message per response');
  const input = messages[0] as AgentInput;
  const reqs = input.blocks.filter(b => b.type === 'tool_req') as { req_id: string; tool: string; params: { command?: string } }[];
  assert.equal(reqs.length, 2);
  assert.deepEqual(reqs.map(r => r.req_id), ['toolu_1', 'toolu_2']);
  assert.equal(reqs[0]?.tool, 'shell_exec');
  assert.equal(reqs[0]?.params.command, 'ls');
  assert.ok(input.blocks.some(b => b.type === 'text' && b.text === 'Checking now.'));
});

test('parseMessage: thinking keeps its signature, redacted thinking stays loud', () => {
  const response = asMessage({
    id: 'msg_2',
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'private reasoning', signature: 'sig-abc' },
      { type: 'redacted_thinking', data: 'encrypted' },
      { type: 'text', text: 'answer' },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message);

  const messages = parseMessage(response);
  const input = messages[0] as AgentInput;
  const thinking = input.blocks.find(b => b.type === 'thinking') as { type: 'thinking'; text: string; anthropic_signature?: string };
  assert.equal(thinking.text, 'private reasoning');
  assert.equal(thinking.anthropic_signature, 'sig-abc');
  assert.ok(input.blocks.some(b => b.type === 'thinking_redacted'));
});

test('parseMessage: server-side blocks are captured as unsupported, not dropped', () => {
  const response = asMessage({
    id: 'msg_3',
    role: 'assistant',
    content: [
      { type: 'text', text: 'ok' },
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message);

  const messages = parseMessage(response);
  const input = messages[0] as AgentInput;
  const unsupported = input.blocks.filter(b => b.type === 'unsupported');
  assert.equal(unsupported.length, 1);
  assert.ok(unsupported[0].text.includes('server_tool_use'));
});

test('formatMessages: an agent turn (input + tool_req) merges into ONE assistant message', () => {
  const history: Message[] = [
    { role: 'user', type: 'input', blocks: [{ type: 'text', text: 'run it' }] },
    {
      role: 'agent', type: 'input',
      blocks: [
        { type: 'text', text: 'Running.' },
        { type: 'thinking', text: 'should be stripped (no signature)', },
      ],
    },
    {
      role: 'agent', type: 'tool_req',
      requests: [{ req_id: 'toolu_9', tool: 'shell_exec', params: { command: 'ls' } }],
    },
  ];

  const wire = formatMessages(projectMessages(history, FAKE_ADAPTER.projection), FAKE_ADAPTER);
  assert.equal(wire.length, 2, 'user + ONE merged assistant message');
  assert.equal(wire[1].role, 'assistant');
  const content = wire[1].content as Anthropic.ContentBlockParam[];
  assert.ok(content.some(b => b.type === 'text' && (b as any).text === 'Running.'));
  const tool_use = content.find(b => b.type === 'tool_use') as any;
  assert.equal(tool_use.id, 'toolu_9');
  assert.equal(tool_use.name, 'shell_exec');
  // thinking stripped: replay_thinking false
  assert.ok(!content.some(b => b.type === 'thinking'));
});

test('formatMessages: a native turn with tool_req blocks projects as ONE assistant message', () => {
  const history: Message[] = [
    { role: 'user', type: 'input', blocks: [{ type: 'text', text: 'run it' }] },
    {
      role: 'agent', type: 'input',
      blocks: [
        { type: 'text', text: 'Running.' },
        { type: 'tool_req', req_id: 'toolu_9', tool: 'shell_exec', params: { command: 'ls' } },
      ],
    },
  ];

  const wire = formatMessages(projectMessages(history, FAKE_ADAPTER.projection), FAKE_ADAPTER);
  assert.equal(wire.length, 2, 'user + ONE assistant message — no merging needed, the turn is one message');
  const content = wire[1].content as Anthropic.ContentBlockParam[];
  assert.ok(content.some(b => b.type === 'text' && (b as any).text === 'Running.'));
  const tool_use = content.find(b => b.type === 'tool_use') as any;
  assert.equal(tool_use.id, 'toolu_9');
  assert.equal(tool_use.name, 'shell_exec');
  assert.deepEqual(tool_use.input, { command: 'ls' });
});

test('formatMessages: consecutive user messages merge, preserving block order', () => {
  const history: Message[] = [
    {
      role: 'user', type: 'notification',
      method: 'message/incoming',
      transport: { type: 'telegram', from_id: 1, chat_id: 2 },
      blocks: [{ type: 'text', text: 'hello' }],
    },
    { role: 'user', type: 'input', blocks: [{ type: 'text', text: 'there' }] },
  ];

  const wire = formatMessages(projectMessages(history, FAKE_ADAPTER.projection), FAKE_ADAPTER);
  assert.equal(wire.length, 1);
  assert.equal(wire[0].role, 'user');
  const texts = (wire[0].content as any[]).filter(b => b.type === 'text').map(b => b.text);
  assert.ok(texts.some(t => t.includes('message/incoming')));
  assert.ok(texts.includes('hello'));
  assert.ok(texts.includes('there'));
});

test('formatMessages: tool results become tool_result blocks, ordered first', () => {
  const history: Message[] = [
    { role: 'user', type: 'input', blocks: [{ type: 'text', text: 'go' }] },
    { role: 'agent', type: 'tool_req', requests: [{ req_id: 'toolu_5', tool: 'shell_exec', params: {} }] },
    {
      role: 'user', type: 'tool_res',
      results: [{ req_id: 'toolu_5', tool: 'shell_exec', blocks: [{ type: 'text', text: 'file-a' }] }],
    },
  ];

  const wire = formatMessages(projectMessages(history, FAKE_ADAPTER.projection), FAKE_ADAPTER);
  assert.equal(wire.length, 3);
  assert.equal(wire[2].role, 'user');
  const first = wire[2].content[0] as any;
  assert.equal(first.type, 'tool_result');
  assert.equal(first.tool_use_id, 'toolu_5');
  assert.ok(JSON.stringify(first.content).includes('file-a'));
});

test('formatMessages: cache breakpoint lands on the tail, never on a tool_result', () => {
  const ttl_adapter = FAKE_ADAPTER;
  const history: Message[] = [
    { role: 'user', type: 'input', blocks: [{ type: 'text', text: 'go' }] },
    { role: 'agent', type: 'tool_req', requests: [{ req_id: 'toolu_5', tool: 'shell_exec', params: {} }] },
    {
      role: 'user', type: 'tool_res',
      results: [{ req_id: 'toolu_5', tool: 'shell_exec', blocks: [{ type: 'text', text: 'out' }] }],
    },
  ];

  const wire = formatMessages(projectMessages(history, ttl_adapter.projection), ttl_adapter);
  const content = wire[2].content as any[];
  // The tail (a tool_result) carries the rolling breakpoint — cache
  // markers are metadata and make the tool round-trip itself cacheable.
  const tail = content[content.length - 1];
  assert.equal(tail.type, 'tool_result');
  assert.equal(tail.cache_control.ttl, '1h');
  assert.equal(content.filter(b => b.cache_control).length, 1);
});

test('formatMessages: unsigned thinking is stripped even with replay enabled', () => {
  const replay_adapter = {
    replay_thinking: true,
    supports_image_input: false,
    prompt_cache_ttl: 'off',
    projection: {
      max_text_length: Infinity,
      exclude_thinking: false,
      thinking_redacted_policy: 'placeholder',
      exclude_tool_traffic: false,
      image_policy: 'placeholder',
      voice_policy: 'placeholder',
    },
  } as unknown as AnthropicSessionModel;
  const history: Message[] = [
    { role: 'user', type: 'input', blocks: [{ type: 'text', text: 'go' }] },
    {
      role: 'agent', type: 'input',
      blocks: [
        { type: 'thinking', text: 'unsigned historical thinking' },
        { type: 'text', text: 'the answer' },
      ],
    },
  ];

  const wire = formatMessages(projectMessages(history, replay_adapter.projection), replay_adapter);
  const content = wire[1].content as any[];
  assert.ok(!content.some(b => b.type === 'thinking'), 'unsigned thinking must never replay');
  assert.ok(content.some(b => b.type === 'text' && b.text === 'the answer'));
});

test('formatMessages: signed thinking replays when replay is enabled', () => {
  const replay_adapter = {
    replay_thinking: true,
    supports_image_input: false,
    prompt_cache_ttl: 'off',
    projection: {
      max_text_length: Infinity,
      exclude_thinking: false,
      thinking_redacted_policy: 'placeholder',
      exclude_tool_traffic: false,
      image_policy: 'placeholder',
      voice_policy: 'placeholder',
    },
  } as unknown as AnthropicSessionModel;
  const history: Message[] = [
    { role: 'user', type: 'input', blocks: [{ type: 'text', text: 'go' }] },
    {
      role: 'agent', type: 'input',
      blocks: [
        { type: 'thinking', text: 'reasoned', anthropic_signature: 'sig-1' },
        { type: 'text', text: 'the answer' },
      ],
    },
  ];

  const wire = formatMessages(projectMessages(history, replay_adapter.projection), replay_adapter);
  const content = wire[1].content as any[];
  const thinking = content.find(b => b.type === 'thinking');
  assert.ok(thinking);
  assert.equal(thinking.signature, 'sig-1');
  assert.equal(thinking.thinking, 'reasoned');
});

test('formatMessages: images are withheld as marked text when vision is unsupported', () => {
  const history: Message[] = [
    {
      role: 'user', type: 'input',
      blocks: [
        { type: 'image', mimeType: 'image/png', data: 'AAAA', caption: 'a photo' },
        { type: 'text', text: 'what is this?' },
      ],
    },
  ];

  const wire = formatMessages(projectMessages(history, FAKE_ADAPTER.projection), FAKE_ADAPTER);
  const content = wire[0].content as any[];
  assert.ok(!content.some(b => b.type === 'image'));
  // Unified projection wording; the caption (content) survives with it.
  assert.ok(content.some(b => b.type === 'text' && b.text.includes('[image omitted: image/png]')));
  assert.ok(content.some(b => b.type === 'text' && b.text.includes('a photo')));
});
