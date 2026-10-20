import { describe, test, before, after } from "node:test";
import assert from "node:assert";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextBlock, ToolDeclBlock } from "@loom/proto";
import {
  AbstractCompletionModel,
  AbstractEmbeddingModel,
  AbstractSynthesisModel,
  AbstractTranscriptionModel,
  AnthropicCompletionModel,
  OpenAICompletionModel,
  TENSORX_BASE_URL,
  TensorXCompletionModel,
  completionModel,
  embeddingModel,
  synthesisModel,
  transcriptionModel,
} from "./index.js";
import { type FakeServer, fakeServer, sendJSON, sendSSE } from "./test-utils.js";

/**
 * End-to-end tests: every factory and model type against a local fake
 * provider API, exercising the real SDK request/stream handling without
 * network access.
 */

const text = (data: string): TextBlock => ({ type: 'data', mime: 'text/plain', data });

const BASE_OPTS = {
  model: 'test-model',
  api_key: 'sk-test',
  timeout: 5_000,
  max_output_size: 1000,
  max_context_size: 10_000,
};

const TOOLS: ToolDeclBlock[] = [{
  type: 'tool_decl',
  name: 'shell_exec',
  description: 'Runs a shell command',
  params_schema: { type: 'object', properties: { command: { type: 'string' } } },
}];

const QUERY = {
  tools: TOOLS,
  system_prompt: 'You are a test.',
  session_id: 'session-1',
  messages: [{ role: 'user' as const, blocks: [text('list /tmp')] }],
};

const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
  id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'test-model',
  choices: [{ index: 0, delta, finish_reason }],
});

const OPENAI_STREAM = [
  chunk({ role: 'assistant', reasoning_content: 'pl' }),
  // Split reasoning deltas: the SDK alone would keep only the last one.
  chunk({ reasoning_content: 'an' }),
  chunk({ content: 'Listing ' }),
  chunk({ content: 'now.' }),
  chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'shell_exec', arguments: '{"command":' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '"ls /tmp"}' } }] }),
  chunk({}, 'tool_calls'),
  {
    id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } },
  },
];

const ANTHROPIC_STREAM = [
  {
    event: 'message_start', data: {
      type: 'message_start',
      message: {
        id: 'msg_1', type: 'message', role: 'assistant', model: 'test-model', content: [],
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
      },
    },
  },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Listing now.' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'shell_exec', input: {} } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls /tmp"}' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
];

/** A canonical 16kHz mono 16-bit WAV of `seconds` length. */
const wav = (seconds: number): Buffer => {
  const byte_rate = 16_000 * 2;
  const data_size = Math.round(seconds * byte_rate);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data_size, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(byte_rate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data_size, 40);
  return Buffer.concat([header, Buffer.alloc(data_size)]);
};

describe("model factories", () => {

  test("completionModel returns provider-specific AbstractCompletionModel instances", () => {
    const openai = completionModel('openai', BASE_OPTS);
    const anthropic = completionModel('anthropic', BASE_OPTS);
    const tensorx = completionModel('tensorx', BASE_OPTS);
    assert.ok(openai instanceof OpenAICompletionModel && openai instanceof AbstractCompletionModel);
    assert.ok(anthropic instanceof AnthropicCompletionModel && anthropic instanceof AbstractCompletionModel);
    assert.ok(tensorx instanceof TensorXCompletionModel && tensorx instanceof OpenAICompletionModel);
  });

  test("tensorx defaults to the TensorX endpoint, overridable via base_url", () => {
    assert.strictEqual(completionModel('tensorx', BASE_OPTS).base_url, TENSORX_BASE_URL);
    assert.strictEqual(completionModel('tensorx', { ...BASE_OPTS, base_url: 'http://proxy/v1' }).base_url, 'http://proxy/v1');
  });

  test("transcription, embedding and synthesis factories return abstract-class instances", () => {
    assert.ok(transcriptionModel('openai', { model: 'whisper-1' }) instanceof AbstractTranscriptionModel);
    assert.ok(embeddingModel('openai', { model: 'emb', api_key: 'sk' }) instanceof AbstractEmbeddingModel);
    assert.ok(synthesisModel('openai', { model: 'tts', voice: 'alloy' }) instanceof AbstractSynthesisModel);
  });

  test("unknown types are rejected at runtime", () => {
    assert.throws(() => completionModel('nope' as 'openai', BASE_OPTS), /Unsupported completion model type: nope/);
    assert.throws(() => transcriptionModel('nope' as 'openai', { model: 'x' }), /Unsupported transcription model type/);
  });

  test("projection follows declared modalities; anthropic never keeps audio", () => {
    const opts = { ...BASE_OPTS, modalities: { images: true, audio: true }, replay_thinking: true };
    const openai = completionModel('openai', opts).projection;
    assert.strictEqual(openai.image_policy, 'keep');
    assert.strictEqual(openai.audio_policy, 'keep');
    assert.strictEqual(openai.exclude_thinking, false);
    assert.strictEqual(completionModel('anthropic', opts).projection.audio_policy, 'placeholder');
    assert.strictEqual(completionModel('openai', BASE_OPTS).projection.image_policy, 'placeholder');
  });

});

describe("completion models over the wire", () => {

  let server: FakeServer;

  before(async () => {
    server = await fakeServer({
      'POST /v1/chat/completions': (_req, res) => sendSSE(res, [...OPENAI_STREAM.map(data => ({ data })), '[DONE]']),
      'POST /v1/messages': (_req, res) => sendSSE(res, ANTHROPIC_STREAM),
      'POST /hang/chat/completions': () => { /* never responds */ },
    });
  });

  after(async () => {
    await server.close();
  });

  test("openai: streams a turn into ONE agent message, with usage", async () => {
    const model = completionModel('openai', { ...BASE_OPTS, base_url: `${server.url}/v1`, extras: { temperature: 0.2, strict_wire: true } });
    const result = await model.query(QUERY);
    assert.deepStrictEqual(result.messages, [{
      role: 'agent',
      blocks: [
        text('Listing now.'),
        { type: 'thinking', text: 'plan' },
        { type: 'tool_call', call_id: 'call_1', tool: 'shell_exec', params: { command: 'ls /tmp' } },
      ],
    }]);
    assert.deepStrictEqual(
      { input: result.input_size, cached: result.cached_size, output: result.output_size },
      { input: 10, cached: 4, output: 5 },
    );
  });

  test("openai: request carries system prompt, tools and extras, never harness-only keys", async () => {
    const model = completionModel('openai', {
      ...BASE_OPTS,
      base_url: `${server.url}/v1`,
      extras: { temperature: 0.2, thinking_wire_style: 'blocks' },
    });
    await model.query(QUERY);
    const body = server.requests.at(-1)!.json;
    assert.strictEqual(body.model, 'test-model');
    assert.strictEqual(body.temperature, 0.2);
    assert.strictEqual(body.max_tokens, 1000);
    assert.strictEqual(body.stream, true);
    assert.deepStrictEqual(body.messages, [
      { role: 'system', content: 'You are a test.' },
      { role: 'user', content: [{ type: 'text', text: 'list /tmp' }] },
    ]);
    assert.deepStrictEqual(body.tools, [{
      type: 'function',
      function: { name: 'shell_exec', description: 'Runs a shell command', parameters: TOOLS[0]!.params_schema },
    }]);
    assert.ok(!('thinking_wire_style' in body), 'harness-only keys never reach the wire');
    assert.ok(!('signal' in body), 'the abort signal never rides in the body');
    assert.strictEqual(body.session_id, 'session-1');
    assert.strictEqual(model.thinking_wire_style, 'blocks', 'legacy keys in extras are honoured');
  });

  test("openai: strict_wire omits session_id, as an option or a legacy extras key", async () => {
    for (const opts of [{ strict_wire: true }, { extras: { strict_wire: true } }]) {
      const model = completionModel('openai', { ...BASE_OPTS, base_url: `${server.url}/v1`, ...opts });
      await model.query(QUERY);
      const body = server.requests.at(-1)!.json;
      assert.ok(!('session_id' in body));
      assert.ok(!('strict_wire' in body));
    }
  });

  test("tensorx: speaks the OpenAI wire format", async () => {
    const model = completionModel('tensorx', { ...BASE_OPTS, base_url: `${server.url}/v1` });
    const result = await model.query(QUERY);
    assert.strictEqual(result.messages[0]!.blocks.length, 3);
    assert.strictEqual(server.requests.at(-1)!.url, '/v1/chat/completions');
  });

  test("anthropic: streams a turn into ONE agent message, with cache-aware usage", async () => {
    const model = completionModel('anthropic', { ...BASE_OPTS, base_url: server.url });
    const result = await model.query(QUERY);
    assert.deepStrictEqual(result.messages, [{
      role: 'agent',
      blocks: [
        text('Listing now.'),
        { type: 'tool_call', call_id: 'toolu_1', tool: 'shell_exec', params: { command: 'ls /tmp' } },
      ],
    }]);
    assert.deepStrictEqual(
      { input: result.input_size, cached: result.cached_size, output: result.output_size },
      { input: 15, cached: 3, output: 7 },
    );
    const body = server.requests.at(-1)!.json;
    assert.deepStrictEqual(body.system, [{ type: 'text', text: 'You are a test.', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    assert.deepStrictEqual(body.tools, [{ name: 'shell_exec', description: 'Runs a shell command', input_schema: TOOLS[0]!.params_schema }]);
    assert.deepStrictEqual(body.messages, [
      { role: 'user', content: [{ type: 'text', text: 'list /tmp', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    ]);
  });

  test("a silent provider trips the stall timeout and the request is aborted", async () => {
    const model = completionModel('openai', { ...BASE_OPTS, base_url: `${server.url}/hang`, timeout: 200 });
    await assert.rejects(model.query(QUERY), /timed out after 200ms without activity/);
  });

});

describe("transcription, embedding and synthesis over the wire", () => {

  let server: FakeServer;
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lib-models-'));
    server = await fakeServer({
      'POST /v1/audio/transcriptions': (_req, res) => sendJSON(res, { text: 'hello there', language: 'en' }),
      'POST /v1/embeddings': (req, res) => {
        const inputs: string[] = Array.isArray(req.json.input) ? req.json.input : [req.json.input];
        // The SDK requests base64 floats by default and decodes them; reply
        // out of order to check that `index` is honoured.
        const encode = (values: number[]) => Buffer.from(new Float32Array(values).buffer).toString('base64');
        const data = inputs.map((_, index) => ({ object: 'embedding', index, embedding: encode([index, 0.5]) })).reverse();
        sendJSON(res, { object: 'list', model: req.json.model, data, usage: { prompt_tokens: 8, total_tokens: 8 } });
      },
      'POST /v1/audio/speech': (req, res) => {
        if (req.json.response_format === 'wav') {
          res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(wav(0.5));
        } else if (req.json.voice === 'timed') {
          res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'X-Duration-Seconds': '2.5' }).end(Buffer.from('MP3DATA'));
        } else {
          res.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end(Buffer.from('MP3DATA'));
        }
      },
    });
  });

  after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("transcription: uploads the file as multipart form data", async () => {
    const file = join(dir, 'note.ogg');
    await writeFile(file, 'OGGDATA');
    const model = transcriptionModel('openai', { model: 'whisper-1', base_url: `${server.url}/v1`, api_key: 'sk', prompt: 'Loom' });
    const result = await model.transcribe(file, 'it');
    assert.strictEqual(result.text, 'hello there');
    assert.strictEqual(result.language, 'en');
    const req = server.requests.at(-1)!;
    assert.strictEqual(req.headers.authorization, 'Bearer sk');
    assert.match(req.headers['content-type']!, /^multipart\/form-data/);
    const body = req.body.toString();
    for (const expected of ['whisper-1', 'OGGDATA', 'filename="note.ogg"', 'Loom', 'name="language"\r\n\r\nit']) {
      assert.ok(body.includes(expected), `multipart body includes ${JSON.stringify(expected)}`);
    }
  });

  test("embedding: sends the configured dimensions and decodes results in input order", async () => {
    const model = embeddingModel('openai', { model: 'emb', api_key: 'sk', base_url: `${server.url}/v1`, dimensions: 2 });
    const single = await model.embed('one');
    assert.deepStrictEqual(single, { embedding: [0, 0.5], tokens: 8 });
    const batch = await model.embedBatch(['a', 'b']);
    assert.deepStrictEqual(batch.map(r => r.embedding), [[0, 0.5], [1, 0.5]]);
    assert.deepStrictEqual(batch.map(r => r.tokens), [4, 4]);
    assert.strictEqual(server.requests.at(-1)!.json.dimensions, 2);
  });

  test("synthesis: wav duration is derived from the header", async () => {
    const out = join(dir, 'speech.wav');
    const model = synthesisModel('openai', { model: 'tts', voice: 'alloy', base_url: `${server.url}/v1`, response_format: 'wav' });
    const result = await model.synthesize('hello', out);
    assert.deepStrictEqual(result, { path: out, duration: 0.5, format: 'wav', voice: 'alloy' });
    assert.deepStrictEqual(await readFile(out), wav(0.5));
  });

  test("synthesis: non-wav formats use X-Duration-Seconds", async () => {
    const out = join(dir, 'speech.mp3');
    const model = synthesisModel('openai', { model: 'tts', voice: 'timed', base_url: `${server.url}/v1` });
    const result = await model.synthesize('hello', out);
    assert.strictEqual(result.duration, 2.5);
    assert.strictEqual(result.format, 'mp3');
  });

  test("synthesis: an underivable duration throws and leaves no file behind", async () => {
    const out = join(dir, 'untimed.mp3');
    const model = synthesisModel('openai', { model: 'tts', voice: 'alloy', base_url: `${server.url}/v1` });
    await assert.rejects(model.synthesize('hello', out), /Cannot derive audio duration/);
    await assert.rejects(stat(out), { code: 'ENOENT' });
  });

});
