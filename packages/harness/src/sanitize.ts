/**
 * UTF8 sanitization for content entering the weave.
 *
 * Discovered live 2026-10-02: an inbound message containing invalid
 * Unicode (lone surrogates — JS emits them as \udXXX JSON escapes, which
 * Postgres JSONB rejects with "unsupported Unicode escape sequence")
 * crashed the activation loop three times before the message could be
 * cleared. The fix, per the ruling of the same evening: anything entering
 * the weave is validated at the projection layer; anything not valid
 * UTF8 is swapped with a placeholder (U+FFFD), never rejected raw.
 *
 * Two write paths are guarded:
 *  - persistence: messages.ts sanitizes `data` before every INSERT/UPDATE
 *    (all message writes route through two functions there);
 *  - context injection: projection.ts sanitizes every message it emits,
 *    which also covers legacy rows written before this guard existed.
 *
 * Sanitization is encoding repair, not a content decision: nothing is
 * dropped, truncated or reframed. Valid content (emoji included — any
 * correctly paired surrogate sequence) passes through byte-identical.
 * Only two classes are replaced, the ones Postgres JSONB rejects:
 *  - lone (unpaired) UTF-16 surrogates;
 *  - the NUL code point (U+0000).
 */

/** A high surrogate not followed by a low one, or a low surrogate not preceded by a high one. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Fast path: scan for any surrogate code unit or NUL. Correctly paired
 * surrogates (emoji, CJK extensions) hit this scan too, but the scan is
 * allocation-free and the replace only runs on the rare dirty string.
 */
const hasDirtyUnits = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0000 || (c >= 0xD800 && c <= 0xDFFF)) return true;
  }
  return false;
};

/**
 * Replace the JSONB-unsafe code points in one string with U+FFFD.
 * Standard Unicode replacement practice: the replacement character is
 * itself the visible marker that content was unrepresentable here.
 */
export const sanitizeText = (s: string): string =>
  hasDirtyUnits(s)
    ? s.replace(LONE_SURROGATE_RE, '\uFFFD').replaceAll('\u0000', '\uFFFD')
    : s;

/**
 * Deep-walk a JSON-able value, sanitizing every string within.
 * Copy-on-dirty: when nothing needed replacing the input reference is
 * returned unchanged (the common case — clean content pays one scan per
 * string and no allocation); dirty objects come back as sanitized
 * shallow copies along the touched path, structure otherwise preserved.
 */
export const sanitizeDeep = <T>(value: T): T => {
  if (typeof value === 'string') return sanitizeText(value) as unknown as T;

  if (Array.isArray(value)) {
    let dirty = false;
    const out = new Array<unknown>(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = sanitizeDeep(value[i]);
      if (out[i] !== value[i]) dirty = true;
    }
    return (dirty ? out : value) as unknown as T;
  }

  if (value !== null && typeof value === 'object') {
    let dirty = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeDeep(v);
      if (out[k] !== v) dirty = true;
    }
    return (dirty ? out : value) as unknown as T;
  }

  return value;
};
