import { is } from "@runtyped/type";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { Block } from "./blocks/index.js";

/**
 * Upper bound for a single buffered line. Partial lines exceeding this are
 * dropped; the remainder of the line will then fail to parse and be discarded.
 */
export const MAX_LINE_LENGTH = 16 * 1024 * 1024;

export const encodeBlock = (block: Block): string => {
  return JSON.stringify(block) + '\n';
};

/**
 * Reads newline-delimited JSON blocks from `stream` and invokes `onBlock` for
 * each valid block, strictly one at a time and in order. The stream is paused
 * while blocks are being processed. Lines that are not valid JSON or not valid
 * blocks are discarded, as are errors thrown by `onBlock`.
 *
 * Returns a function that detaches the reader from the stream.
 */
export const readBlocks = (stream: Readable, onBlock: (block: Block) => Promise<void>): () => void => {

  // Decoding via StringDecoder keeps multi-byte characters intact when they
  // are split across chunks.
  const decoder = new StringDecoder('utf8');
  const queue: Block[] = [];
  let buffer = '';
  let draining = false;
  let detached = false;

  const parseLine = (line: string) => {
    if (line.trim().length === 0) {
      return;
    }
    try {
      const maybe_block = JSON.parse(line);
      if (is<Block>(maybe_block)) {
        queue.push(maybe_block);
      }
      // TODO: report discarded lines
    } catch (err) {
      // TODO: report discarded lines
    }
  };

  const drain = async () => {
    if (draining) {
      return;
    }
    draining = true;
    stream.pause();
    while (queue.length > 0) {
      try {
        await onBlock(queue.shift()!);
      } catch (err) {
        // errors in handlers must not break the read loop
      }
    }
    draining = false;
    if (!detached) {
      stream.resume();
    }
  };

  const onData = (data: Buffer | string) => {
    buffer += typeof data === 'string' ? data : decoder.write(data);
    let start = 0;
    let idx: number;
    while ((idx = buffer.indexOf('\n', start)) !== -1) {
      parseLine(buffer.slice(start, idx));
      start = idx + 1;
    }
    buffer = buffer.slice(start);
    if (buffer.length > MAX_LINE_LENGTH) {
      buffer = '';
    }
    if (queue.length > 0) {
      void drain();
    }
  };

  stream.on('data', onData);

  return () => {
    detached = true;
    stream.off('data', onData);
  };
};
