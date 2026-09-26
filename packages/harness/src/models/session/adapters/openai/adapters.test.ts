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
