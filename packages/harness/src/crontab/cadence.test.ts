
import { test } from 'node:test';
import assert from 'node:assert';
import { HEARTBEAT_CADENCE, nextActivation, parseCadence } from './cadence.js';

// Fixed reference point: a Thursday, 2026-10-01 09:00:00 UTC.
const FROM = new Date('2026-10-01T09:00:00Z');

test('heartbeat token parses (case-insensitive, whitespace-tolerant)', () => {
  for (const raw of ['@heartbeat', '@Heartbeat', ' @HEARTBEAT ', '@heartbeat\t']) {
    const parsed = parseCadence(raw);
    assert.strictEqual(parsed.kind, 'heartbeat', raw);
  }
  assert.strictEqual(HEARTBEAT_CADENCE, '@heartbeat');
});

test('heartbeat cadence has no next activation (the scan skips it)', () => {
  assert.strictEqual(nextActivation('@heartbeat', FROM), null);
});

test('cron expressions parse and produce the next matching instant', () => {
  const parsed = parseCadence('*/5 * * * *');
  assert.strictEqual(parsed.kind, 'cron');
  const next = nextActivation('*/5 * * * *', FROM);
  assert.ok(next);
  assert.strictEqual(next.toISOString(), '2026-10-01T09:05:00.000Z');
});

test('cron dom/dow OR-quirk comes from the library, not re-derivation', () => {
  // 0 0 1 * 1: 1st of the month OR any Monday — the classic cron OR rule.
  // If this were AND-ed, the next match would be Dec 1 2026 (a Tuesday);
  // the OR rule yields Monday Oct 5. Cron semantics are SERVER-LOCAL
  // time (same lane as systemd timers) — assert local components, not
  // UTC instants.
  const next = nextActivation('0 0 1 * 1', new Date('2026-10-02T00:00:00Z'));
  assert.ok(next);
  assert.strictEqual(next.getFullYear(), 2026);
  assert.strictEqual(next.getMonth(), 9); // October
  assert.strictEqual(next.getDate(), 5);
  assert.strictEqual(next.getDay(), 1); // Monday
  assert.strictEqual(next.getHours(), 0);
  assert.strictEqual(next.getMinutes(), 0);
});

test('next-after-from is strictly after the reference, never equal', () => {
  // FROM is exactly on a 5-minute boundary; the next slot must be the
  // FOLLOWING one — the fire-recalc contract (claim with from=now must
  // not re-claim the same instant).
  const next = nextActivation('*/5 * * * *', new Date('2026-10-01T09:05:00Z'));
  assert.ok(next);
  assert.strictEqual(next.toISOString(), '2026-10-01T09:10:00.000Z');
});

test('@macros are accepted (library semantics, not re-derived)', () => {
  const next = nextActivation('@daily', FROM);
  assert.ok(next);
  // Local midnight (server-local lane), one day out at most.
  assert.strictEqual(next.getHours(), 0);
  assert.strictEqual(next.getMinutes(), 0);
  const diff_ms = next.valueOf() - FROM.valueOf();
  assert.ok(diff_ms > 0 && diff_ms <= 24 * 3600_000, `@daily next ${diff_ms}ms out`);
});

test('invalid cadences throw (fail-fast at the CRUD boundary)', () => {
  for (const bad of ['not a cron', '* * * *', '99 * * * *', '']) {
    assert.throws(() => parseCadence(bad), /./, bad);
  }
});
