import { describe, test } from "node:test";
import assert from "node:assert";
import { PassThrough } from "node:stream";
import { encodeBlock, readBlocks } from "./framing.js";
import type { Block, TextBlock } from "./blocks/index.js";
import { waitFor } from "./test-utils.js";

const text = (data: string): TextBlock => ({ type: 'data', mime: 'text/plain', data });

const collect = (stream: PassThrough) => {
  const blocks: Block[] = [];
  const detach = readBlocks(stream, async (block) => { blocks.push(block); });
  return { blocks, detach };
};

describe("readBlocks", () => {

  test("delivers every block when several arrive in one chunk", async () => {
    const stream = new PassThrough();
    const { blocks } = collect(stream);
    stream.write(encodeBlock(text('a')) + encodeBlock(text('b')) + encodeBlock(text('c')));
    await waitFor(() => blocks.length === 3);
    assert.deepStrictEqual(blocks, [text('a'), text('b'), text('c')]);
  });

  test("reassembles a block split across chunks", async () => {
    const stream = new PassThrough();
    const { blocks } = collect(stream);
    const raw = encodeBlock(text('split me'));
    stream.write(raw.slice(0, 5));
    stream.write(raw.slice(5, 20));
    stream.write(raw.slice(20));
    await waitFor(() => blocks.length === 1);
    assert.deepStrictEqual(blocks, [text('split me')]);
  });

  test("keeps multi-byte characters intact across chunk boundaries", async () => {
    const stream = new PassThrough();
    const { blocks } = collect(stream);
    const raw = Buffer.from(encodeBlock(text('héllo wörld 🧶')));
    // Split inside the 4-byte emoji sequence.
    const cut = raw.indexOf(Buffer.from('🧶')) + 2;
    stream.write(raw.subarray(0, cut));
    stream.write(raw.subarray(cut));
    await waitFor(() => blocks.length === 1);
    assert.deepStrictEqual(blocks, [text('héllo wörld 🧶')]);
  });

  test("discards invalid lines without affecting subsequent blocks", async () => {
    const stream = new PassThrough();
    const { blocks } = collect(stream);
    stream.write('not json\n');
    stream.write('{"type":"not_a_block"}\n');
    stream.write('\n');
    stream.write(encodeBlock(text('ok')));
    await waitFor(() => blocks.length === 1);
    assert.deepStrictEqual(blocks, [text('ok')]);
  });

  test("processes blocks sequentially, in order", async () => {
    const stream = new PassThrough();
    const seen: string[] = [];
    let in_flight = 0;
    let max_in_flight = 0;
    readBlocks(stream, async (block) => {
      in_flight += 1;
      max_in_flight = Math.max(max_in_flight, in_flight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push((block as TextBlock).data!);
      in_flight -= 1;
    });
    stream.write(encodeBlock(text('1')) + encodeBlock(text('2')));
    stream.write(encodeBlock(text('3')));
    await waitFor(() => seen.length === 3);
    assert.deepStrictEqual(seen, ['1', '2', '3']);
    assert.strictEqual(max_in_flight, 1);
  });

  test("keeps reading after a handler throws", async () => {
    const stream = new PassThrough();
    const seen: string[] = [];
    readBlocks(stream, async (block) => {
      const data = (block as TextBlock).data!;
      if (data === 'bad') throw new Error('handler failure');
      seen.push(data);
    });
    stream.write(encodeBlock(text('bad')) + encodeBlock(text('good')));
    await waitFor(() => seen.length === 1);
    assert.deepStrictEqual(seen, ['good']);
  });

  test("stops delivering blocks once detached", async () => {
    const stream = new PassThrough();
    const { blocks, detach } = collect(stream);
    stream.write(encodeBlock(text('before')));
    await waitFor(() => blocks.length === 1);
    detach();
    stream.write(encodeBlock(text('after')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepStrictEqual(blocks, [text('before')]);
  });

});
