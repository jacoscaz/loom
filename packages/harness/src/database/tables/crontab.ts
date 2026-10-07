import type { GeneratedAlways, Insertable, Selectable, Updateable } from 'kysely';

/**
 * One crontab row = one hook: a sensor, not an actuator (design of
 * record: coord 8-2026-10-05-heartbeat-polling-hooks). `cadence` is a
 * cron expression or the `@heartbeat` token; `next_activation` is
 * derived state, always recomputed by the runner — never hand-synced.
 */
export interface CrontabRow {
  id: GeneratedAlways<number>;
  /** Unique, human-meaningful hook name (also the event's identity in the weave). */
  name: string;
  /** Cron expression (5-field, cron-schedule semantics) or '@heartbeat'. */
  cadence: string;
  /** Shell command, executed with mechanical caps (timeout + ulimits). */
  command: string;
  /** Optional regex: when set, the firing injects only if the output matches. */
  match: string | null;
  /** Whether a firing injects into the weave at all (silent sensors still record output). */
  notify: boolean;
  enabled: boolean;
  /** Next due time (cron rows only; NULL for @heartbeat rows). */
  next_activation: Date | null;
  last_fired_at: Date | null;
  /** Last execution's combined output, truncated to the configured byte cap. */
  last_output: string | null;
  created_at: Date;
  updated_at: Date | null;
}

export type SelectableCrontabRow = Selectable<CrontabRow>;
export type NewCrontabRow = Insertable<CrontabRow>;
export type CrontabRowUpdate = Updateable<CrontabRow>;
