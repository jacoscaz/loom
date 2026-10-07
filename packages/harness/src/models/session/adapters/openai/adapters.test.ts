import { test } from "node:test";
import assert from "node:assert";
import OpenAI from "openai";
import { parseMessage } from "./parsers.js";
import { formatMessage, formatMessages } from "./formatters.js";
import { projectMessage } from "../../../../projection.js";
import { type OpenAISessionModel } from "./openai.js";
import { type AgentInput, type Message } from "../../../../types/messages.js";

/**
 * Adapter-level guarantees for unsupported blocks: whatever a provider
 * response carries that the adapter cannot represent natively is kept
 * (as an unsupported block) rather than dropped, and whatever is stored
 * as unsupported replays to the provider as loud marked text.
 */

const FAKE_ADAPTER = {
  replay_thinking: false,
  supports_image_input: false,
  // The adapter's content decisions now come from its projection profile.
  projection: {
    max_text_length: Infinity,
    exclude_thinking: true,
    thinking_redacted_policy: 'placeholder',
    exclude_tool_traffic: false,
    image_policy: 'placeholder',
    voice_policy: 'placeholder',
  },
} as unknown as OpenAISessionModel;

test('parseMessage: annotations are captured as an unsupported block', () => {
  const response = {
    role: 'assistant',
    content: 'Here is the answer.',
    annotations: [{ type: 'url_citation', url: 'https://example.com' }],
  } as unknown as OpenAI.ChatCompletionMessage;

  const messages = parseMessage(response);
  const input = messages.find(m => m.type === 'input') as AgentInput;
  const unsupported = input.blocks.filter(b => b.type === 'unsupported');
  assert.equal(unsupported.length, 1);
  assert.ok(unsupported[0].text.includes('[annotations]'));
  assert.ok(unsupported[0].text.includes('url_citation'));
  // Normal content still parses as text alongside it.
  const text = input.blocks.find(b => b.type === 'text');
  assert.ok(text && 'text' in text && text.text === 'Here is the answer.');
});

test('parseMessage: legacy function_call is captured as an unsupported block', () => {
  const response = {
    role: 'assistant',
    content: null,
    function_call: { name: 'shell_exec', arguments: '{"command":"ls"}' },
  } as unknown as OpenAI.ChatCompletionMessage;

  const messages = parseMessage(response);
  const input = messages.find(m => m.type === 'input') as AgentInput;
  const unsupported = input.blocks.filter(b => b.type === 'unsupported');
  assert.equal(unsupported.length, 1);
  assert.ok(unsupported[0].text.includes('[legacy function_call]'));
  assert.ok(unsupported[0].text.includes('shell_exec'));
});

test('parseMessage: a plain response produces no unsupported blocks', () => {
  const response = {
    role: 'assistant',
    content: 'plain text',
  } as unknown as OpenAI.ChatCompletionMessage;

  const messages = parseMessage(response);
  const input = messages[0] as AgentInput;
  assert.ok(input.blocks.every(b => b.type === 'text'));
});

test('formatMessage: unsupported and thinking_redacted replay as loud marked text', () => {
  const message: Message = {
    role: 'agent',
    type: 'input',
    blocks: [
      { type: 'thinking_redacted', text: '' },
      { type: 'unsupported', text: '[annotations] [{"type":"url_citation"}]' },
      { type: 'text', text: 'the visible answer' },
    ],
  };

  const wire = formatMessage(projectMessage(message, FAKE_ADAPTER.projection)!, FAKE_ADAPTER);
  assert.equal(wire.length, 1);
  const assistant = wire[0] as { role: string; content?: string; reasoning_content?: string };
  assert.equal(assistant.role, 'assistant');
  assert.ok(assistant.content?.includes('[unsupported] [annotations]'));
  assert.ok(assistant.content?.includes('[thinking redacted]'));
  assert.ok(assistant.content?.includes('the visible answer'));
  // replay_thinking is false on the fake adapter: no reasoning_content.
  assert.equal(assistant.reasoning_content, undefined);
});

/**
 * Fold guarantees (2026-09-26, split-self fix): an agent turn that thinks,
 * writes, and calls tools must project as ONE assistant wire message with
 * reasoning_content + content + tool_calls together — several providers
 * (MiMo 2.6 on DeepInfra) require reasoning preserved alongside tool calls
 * and shed self-motivated continuation calls when the turn is split.
 */

const FAKE_THINKING_ADAPTER = {
  replay_thinking: true,
  supports_image_input: false,
  projection: {
    max_text_length: Infinity,
    exclude_thinking: false,
    thinking_redacted_policy: 'placeholder',
    exclude_tool_traffic: false,
    image_policy: 'placeholder',
    voice_policy: 'placeholder',
  },
} as unknown as OpenAISessionModel;

test('formatMessages: a tool request folds into the preceding assistant message', () => {
  const messages: Message[] = [
    {
      role: 'agent',
      type: 'input',
      blocks: [
        { type: 'thinking', text: 'the reasoning' },
        { type: 'text', text: 'calling now' },
      ],
    },
    {
      role: 'agent',
      type: 'tool_req',
      requests: [{ req_id: 'r1', tool: 'shell_exec', params: { command: 'ls' } }],
    },
  ];

  const wire = formatMessages(messages, FAKE_THINKING_ADAPTER);
  assert.equal(wire.length, 1);
  const assistant = wire[0] as {
    role: string;
    reasoning_content?: string;
    content?: string;
    tool_calls?: { function: { name: string } }[];
  };
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.reasoning_content, 'the reasoning');
  assert.ok(assistant.content?.includes('calling now'));
  assert.equal(assistant.tool_calls?.length, 1);
  assert.equal(assistant.tool_calls?.[0]?.function?.name, 'shell_exec');
});

test('formatMessages: a bare tool request with no preceding assistant stays standalone', () => {
  const messages: Message[] = [
    {
      role: 'agent',
      type: 'tool_req',
      requests: [{ req_id: 'r1', tool: 'shell_exec', params: { command: 'ls' } }],
    },
  ];

  const wire = formatMessages(messages, FAKE_THINKING_ADAPTER);
  assert.equal(wire.length, 1);
  const assistant = wire[0] as { role: string; tool_calls?: unknown[] };
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.tool_calls?.length, 1);
});

test('formatMessages: a tool request after a user message folds only into assistant turns', () => {
  const messages: Message[] = [
    { role: 'user', type: 'input', blocks: [{ type: 'text', text: 'hello' }] },
    {
      role: 'agent',
      type: 'tool_req',
      requests: [{ req_id: 'r1', tool: 'shell_exec', params: { command: 'ls' } }],
    },
    {
      role: 'user',
      type: 'tool_res',
      results: [{ req_id: 'r1', tool: 'shell_exec', blocks: [{ type: 'text', text: 'done' }] }],
    },
  ];

  const wire = formatMessages(messages, FAKE_THINKING_ADAPTER);
  // user + standalone assistant (no prior assistant to fold into) + tool results
  assert.equal(wire.length, 3);
  assert.equal((wire[0] as { role: string }).role, 'user');
  assert.equal((wire[1] as { role: string }).role, 'assistant');
  assert.equal((wire[2] as { role: string }).role, 'tool');
});

/**
 * Audio guarantees (2026-09-26, audio-to-substrate): when the profile keeps
 * voice (modalities.audio), a voice block projects as native input_audio plus
 * its labelled transcript text; when data is missing (ingest conversion
 * failed) the transcript text still rides and nothing pretends audio exists.
 */

const FAKE_AUDIO_ADAPTER = {
  replay_thinking: false,
  supports_image_input: false,
  supports_audio_input: true,
  projection: {
    max_text_length: Infinity,
    exclude_thinking: true,
    thinking_redacted_policy: 'placeholder',
    exclude_tool_traffic: false,
    image_policy: 'placeholder',
    voice_policy: 'keep',
  },
} as unknown as OpenAISessionModel;

test('formatMessages: a kept voice block projects input_audio plus labelled transcript', () => {
  const messages: Message[] = [
    {
      role: 'user',
      type: 'input',
      blocks: [
        {
          type: 'voice',
          path: '/tmp/x.ogg',
          mimeType: 'audio/ogg',
          duration: 30,
          transcription: 'the spoken words',
          data: 'AAAA',
          dataFormat: 'wav',
        },
      ],
    },
  ];

  const wire = formatMessages(messages, FAKE_AUDIO_ADAPTER);
  assert.equal(wire.length, 1);
  const user = wire[0] as {
    role: string;
    content: { type: string; input_audio?: { data: string; format: string }; text?: string }[];
  };
  assert.equal(user.role, 'user');
  assert.ok(Array.isArray(user.content));
  const audio = user.content.find((p) => p.type === 'input_audio');
  assert.ok(audio, 'input_audio part present');
  assert.equal(audio?.input_audio?.data, 'AAAA');
  assert.equal(audio?.input_audio?.format, 'wav');
  const marker = user.content.find((p) => p.type === 'text');
  assert.ok(marker?.text?.includes('voice note, 30s, audio attached'));
  assert.ok(marker?.text?.includes('the spoken words'));
});

test('formatMessages: a kept voice block without data degrades to transcript text, honestly labelled', () => {
  const messages: Message[] = [
    {
      role: 'user',
      type: 'input',
      blocks: [
        { type: 'voice', path: '/tmp/y.ogg', mimeType: 'audio/ogg', duration: 12, transcription: 'just text' },
      ],
    },
  ];

  const wire = formatMessages(messages, FAKE_AUDIO_ADAPTER);
  const user = wire[0] as { role: string; content: { type: string; text?: string }[] };
  assert.equal(user.role, 'user');
  assert.equal(user.content.length, 1);
  assert.equal(user.content[0]?.type, 'text');
  assert.ok(user.content[0]?.text?.includes('audio unavailable'));
  assert.ok(user.content[0]?.text?.includes('just text'));
});

/**
 * Native turn shape (2026-09-26, ToolRequestBlock within AgentInput):
 * tool calls are blocks INSIDE the turn — reasoning, text and calls
 * project as ONE assistant message with no wire-level folding. The fold
 * guarantees above are legacy-compat for history rows only.
 */

test('parseMessage: tool_calls become tool_req blocks within the AgentInput', () => {
  const response = {
    role: 'assistant',
    content: 'Calling now.',
    reasoning_content: 'the reasoning',
    tool_calls: [
      { id: 'r1', type: 'function', function: { name: 'shell_exec', arguments: '{"command":"ls"}' } },
      { id: 'r2', type: 'function', function: { name: 'file_read', arguments: '{"path":"/a"}' } },
    ],
  } as unknown as OpenAI.ChatCompletionMessage;

  const messages = parseMessage(response);
  assert.equal(messages.length, 1, 'one canonical message per response');
  const input = messages[0] as AgentInput;
  const reqs = input.blocks.filter(b => b.type === 'tool_req') as { req_id: string; tool: string; params: { command?: string } }[];
  assert.equal(reqs.length, 2);
  assert.deepEqual(reqs.map(r => r.req_id), ['r1', 'r2']);
  assert.equal(reqs[0]?.tool, 'shell_exec');
  assert.equal(reqs[0]?.params.command, 'ls');
  assert.ok(input.blocks.some(b => b.type === 'text'));
  assert.ok(input.blocks.some(b => b.type === 'thinking'));
});

test('formatMessages: a native turn with tool_req blocks projects as ONE assistant message', () => {
  const messages: Message[] = [
    {
      role: 'agent',
      type: 'input',
      blocks: [
        { type: 'thinking', text: 'the reasoning' },
        { type: 'text', text: 'calling now' },
        { type: 'tool_req', req_id: 'r1', tool: 'shell_exec', params: { command: 'ls' } },
      ],
    },
  ];

  const wire = formatMessages(messages, FAKE_THINKING_ADAPTER);
  assert.equal(wire.length, 1, 'no folding needed — the turn is one message');
  const assistant = wire[0] as {
    role: string;
    reasoning_content?: string;
    content?: string;
    tool_calls?: { id: string; function: { name: string } }[];
  };
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.reasoning_content, 'the reasoning');
  assert.ok(assistant.content?.includes('calling now'));
  assert.equal(assistant.tool_calls?.length, 1);
  assert.equal(assistant.tool_calls?.[0]?.id, 'r1');
  assert.equal(assistant.tool_calls?.[0]?.function?.name, 'shell_exec');
});

test('round trip: a native turn survives format -> parse with its grouping intact', () => {
  const turn: Message = {
    role: 'agent',
    type: 'input',
    blocks: [
      { type: 'thinking', text: 'the reasoning' },
      { type: 'text', text: 'calling now' },
      { type: 'tool_req', req_id: 'r1', tool: 'shell_exec', params: { command: 'ls' } },
    ],
  };

  const wire = formatMessages([turn], FAKE_THINKING_ADAPTER);
  assert.equal(wire.length, 1);
  const parsed = parseMessage(wire[0] as unknown as OpenAI.ChatCompletionMessage);
  assert.equal(parsed.length, 1);
  const input = parsed[0] as AgentInput;
  // Wire fields carry fixed slots (content, reasoning_content, tool_calls),
  // so parse rebuilds text-then-thinking regardless of original block order
  // — the grouping (one turn, all three kinds) is what survives, losslessly.
  assert.deepEqual(input.blocks.map(b => b.type), ['text', 'thinking', 'tool_req']);
  assert.ok(input.blocks.some(b => b.type === 'thinking' && b.text === 'the reasoning'));
  assert.ok(input.blocks.some(b => b.type === 'text' && b.text === 'calling now'));
  const req = input.blocks.find(b => b.type === 'tool_req') as { req_id: string; params: { command: string } };
  assert.equal(req.req_id, 'r1');
  assert.equal(req.params.command, 'ls');

  // Prosthetic-rule audit (Log #3451): mediation must be verifiable IN its
  // mediation. Replay stability — a re-format of the grown history is
  // deep-equal to the first — makes a silently no-oping adapter visible as
  // a test failure, not as the return of tool-shedding dressed as
  // degradation. (Adapted from PR #50's 6e794c7, whose inbound half
  // asserted the split parse this redesign eliminates.)
  const history: Message[] = [
    { role: 'user', type: 'input', blocks: [{ type: 'text', text: 'hello' }] },
    turn,
    {
      role: 'user',
      type: 'tool_res',
      results: [{ req_id: 'r1', tool: 'shell_exec', blocks: [{ type: 'text', text: 'done' }] }],
    },
  ];
  const first = formatMessages(history, FAKE_THINKING_ADAPTER);
  const replay = formatMessages(history, FAKE_THINKING_ADAPTER);
  assert.deepEqual(replay, first, 're-formatting the same history is stable');
});

// Mistral-style block content (documented deviation from the OpenAI schema,
// docs.mistral.ai capabilities/reasoning): with reasoning on, message.content
// is a LIST of typed chunks — ThinkChunk and TextChunk — not a string. The
// adapter must normalize this provider-specific shape into the canonical
// message form: thinking chunks become thinking blocks, text chunks join
// into one text block, unknown chunk types are captured loudly.

test('parseMessage: Mistral block content — thinking and text chunks normalize', () => {
  const response = {
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking: [
          { type: 'text', text: 'The user asks 2+2. ' },
          { type: 'text', text: 'The answer is 4.' },
        ],
        closed: true,
      },
      { type: 'text', text: '4' },
    ],
  } as unknown as OpenAI.ChatCompletionMessage;

  const messages = parseMessage(response);
  const input = messages.find(m => m.type === 'input') as AgentInput;
  const thinking = input.blocks.find(b => b.type === 'thinking') as { type: string; text: string };
  const text = input.blocks.find(b => b.type === 'text') as { type: string; text: string };
  assert.ok(thinking, 'thinking chunk becomes a thinking block');
  assert.equal(thinking.text, 'The user asks 2+2. \nThe answer is 4.');
  assert.ok(text, 'text chunks concatenate into one text block');
  assert.equal(text.text, '4');
  // Nothing leaked as unsupported — every chunk type was understood.
  assert.equal(input.blocks.filter(b => b.type === 'unsupported').length, 0);
});

test('parseMessage: Mistral block content — unknown chunk types are kept loudly', () => {
  const response = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'answer' },
      { type: 'mystery_chunk', payload: { x: 1 } },
    ],
  } as unknown as OpenAI.ChatCompletionMessage;

  const messages = parseMessage(response);
  const input = messages.find(m => m.type === 'input') as AgentInput;
  const unsupported = input.blocks.filter(b => b.type === 'unsupported');
  assert.equal(unsupported.length, 1);
  assert.ok(unsupported[0].text.includes('[content chunk]'));
  assert.ok(unsupported[0].text.includes('mystery_chunk'));
  const text = input.blocks.find(b => b.type === 'text') as { type: string; text: string };
  assert.equal(text.text, 'answer');
});

test('formatAgentInput: thinking_wire_style blocks — Mistral chunk-list content, no reasoning_content field', () => {
  const turn: Message = {
    role: 'agent',
    type: 'input',
    blocks: [
      { type: 'thinking', text: 'greet back' },
      { type: 'text', text: 'hello' },
      { type: 'tool_req', req_id: 'r1', tool: 'ls', params: {} },
    ],
  } as Message;
  const BLOCKS_ADAPTER = {
    ...FAKE_THINKING_ADAPTER,
    thinking_wire_style: 'blocks',
  } as unknown as OpenAISessionModel;

  const wire = formatMessages([{ role: 'user', type: 'input', blocks: [{ type: 'text', text: 'hi' }] }, turn], BLOCKS_ADAPTER);
  const asst = wire.find(m => m.role === 'assistant') as { content: unknown; reasoning_content?: unknown; tool_calls?: unknown[] };
  // Mistral's shape: content is a list of typed chunks, thinking first
  const content = asst.content as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(content), 'content is a chunk list in blocks style');
  assert.equal(content[0].type, 'thinking');
  assert.deepEqual((content[0].thinking as Array<Record<string, unknown>>)[0].text, 'greet back');
  assert.equal(content[1].type, 'text');
  assert.equal(content[1].text, 'hello');
  // The DeepSeek-style extension field must NOT appear — Mistral rejects it
  // as extra_forbidden (HTTP 422, live-verified 2026-10-07).
  assert.equal(asst.reasoning_content, undefined);
  assert.ok(Array.isArray(asst.tool_calls) && asst.tool_calls.length === 1, 'tool_calls ride alongside');
});

test('formatAgentInput: thinking_wire_style blocks — no thinking falls back to plain string', () => {
  const turn: Message = {
    role: 'agent',
    type: 'input',
    blocks: [{ type: 'text', text: 'plain answer' }],
  } as Message;
  const BLOCKS_ADAPTER = {
    ...FAKE_THINKING_ADAPTER,
    thinking_wire_style: 'blocks',
  } as unknown as OpenAISessionModel;

  const wire = formatMessages([turn], BLOCKS_ADAPTER);
  const asst = wire[0] as { role: string; content: unknown };
  assert.equal(asst.role, 'assistant');
  assert.equal(asst.content, 'plain answer');
});

test('parseMessage: Mistral block content — thinking-only response yields no empty text block', () => {
  const response = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: [{ type: 'text', text: 'still deciding' }], closed: false },
    ],
  } as unknown as OpenAI.ChatCompletionMessage;

  const messages = parseMessage(response);
  const input = messages.find(m => m.type === 'input') as AgentInput;
  assert.ok(input.blocks.some(b => b.type === 'thinking' && b.text === 'still deciding'));
  assert.equal(input.blocks.filter(b => b.type === 'text').length, 0);
});
