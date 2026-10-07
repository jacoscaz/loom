
import { parseCronExpression, type Cron } from 'cron-schedule';

/**
 * Cadence vocabulary for the crontab (design of record: coord
 * 8-2026-10-05-heartbeat-polling-hooks). A cadence is shape-owned TEXT:
 *
 * - `@heartbeat` (case-insensitive, trimmed) — agent-time. The row has
 *   no next_activation; the heartbeat path dispatches it when the agent
 *   activates. Presence-tied, never wakes.
 * - anything else — a cron expression, validated by cron-schedule v6
 *   (the pretrained fluency choice, Jacopo 2026-10-05 10:20: no
 *   re-derived cron semantics; dom/dow OR-quirk included by using the
 *   library). 5-field minute-granularity and @macros both accepted;
 *   process-local timezone (same lane as systemd timers on this host —
 *   wall-clock-precise work stays in systemd's lane by design).
 */

export const HEARTBEAT_CADENCE = '@heartbeat';

export type ParsedCadence =
  | { kind: 'heartbeat' }
  | { kind: 'cron'; cron: Cron };

/**
 * Parse a cadence string. Throws on invalid cron expressions — the CRUD
 * tool calls this at create/update time, so bad cadences fail fast at
 * the boundary, never silently at scan time.
 */
export const parseCadence = (cadence: string): ParsedCadence => {
  const trimmed = cadence.trim();
  if (trimmed.toLowerCase() === HEARTBEAT_CADENCE) {
    return { kind: 'heartbeat' };
  }
  // parseCronExpression throws with a descriptive message on invalid input.
  return { kind: 'cron', cron: parseCronExpression(trimmed) };
};

/**
 * The next activation for a cadence, strictly after `from`.
 * Heartbeat cadences have none (NULL by convention — the scan skips
 * them; the heartbeat path owns them).
 *
 * next-after-`from` is the fire-recalc contract: the runner recomputes
 * with `from = now` right after claiming a firing, which makes downtime
 * catch-up one late firing instead of a burst of every missed slot.
 */
export const nextActivation = (cadence: string, from: Date): Date | null => {
  const parsed = parseCadence(cadence);
  if (parsed.kind === 'heartbeat') return null;
  return parsed.cron.getNextDate(from);
};
