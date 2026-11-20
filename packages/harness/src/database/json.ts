
/**
 * JSON codec for jsonb columns. Plain JSON.stringify() turns Buffers into
 * `{ type: 'Buffer', data: [...] }` (one JSON number per byte) and
 * JSON.parse() never turns them back. Media blocks carry their bytes as
 * Buffers, so Buffers are encoded as `{ $buffer: '<base64>' }` instead
 * and revived on the way out.
 */

const BUFFER_KEY = '$buffer';

export const encodeJson = (value: unknown): string => {
  return JSON.stringify(value, function (this: any, key: string, val: unknown) {
    // `val` has already been through Buffer#toJSON(); `this[key]` has not.
    const raw = this[key];
    if (Buffer.isBuffer(raw)) {
      return { [BUFFER_KEY]: raw.toString('base64') };
    }
    return val;
  });
};

export const decodeJson = (text: string): any => {
  return JSON.parse(text, (_key, val) => {
    if (val !== null && typeof val === 'object' && typeof val[BUFFER_KEY] === 'string' && Object.keys(val).length === 1) {
      return Buffer.from(val[BUFFER_KEY], 'base64');
    }
    return val;
  });
};
