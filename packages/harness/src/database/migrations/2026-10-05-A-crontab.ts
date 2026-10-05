
import { Kysely, sql } from 'kysely';

/**
 * Crontab (2026-10-05, with Jacopo): sensor organs for the heartbeat —
 * agent-authored hooks as DB rows, fired by a resident runner.
 *
 * Design of record: coord task 8-2026-10-05-heartbeat-polling-hooks
 * (design CLOSED 2026-10-05 10:55 UTC+2). Key semantics:
 *
 * - `cadence` is TEXT and shape-owned: a cron expression (5-field,
 *   cron-schedule v6 semantics — dom/dow OR-quirk included by using the
 *   library, not re-deriving it) OR the `@heartbeat` token.
 * - `next_activation` is derived state, recomputed lazily at every
 *   write (create/update/enable) and after every firing (next-after-NOW:
 *   downtime catch-up is one late firing, never a burst of missed slots).
 *   NULL means agent-time: `@heartbeat` rows are stateless, skipped by
 *   the process-time scan, dispatched by the heartbeat path instead.
 * - Firing is decoupled from agent activation (sensors on the clock);
 *   results flow into the weave as inbound events (cron rows via the
 *   notification bus, which wakes the session; @heartbeat rows as event
 *   injections, which never wake — presence-tied).
 * - Double-fire protection is the harness's single-instance pid guard
 *   (src/pid-file.ts): only one loom process ever runs the scan loop.
 * - `last_fired_at` / `last_output` are the audit trail: a sensor that
 *   runs silently (notify=false) or does not match still leaves its
 *   output legible for later conscious reading.
 */
export async function up(trx: Kysely<any>): Promise<void> {
  await trx.schema
    .createTable('crontab')
    .addColumn('id', 'serial', col => col.primaryKey())
    .addColumn('name', 'text', col => col.notNull().unique())
    .addColumn('cadence', 'text', col => col.notNull())
    .addColumn('command', 'text', col => col.notNull())
    .addColumn('match', 'text')
    .addColumn('notify', 'boolean', col => col.notNull().defaultTo(true))
    .addColumn('enabled', 'boolean', col => col.notNull().defaultTo(true))
    .addColumn('next_activation', 'timestamptz')
    .addColumn('last_fired_at', 'timestamptz')
    .addColumn('last_output', 'text')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz')
    .execute();

  await trx.schema
    .createIndex('crontab_due_idx')
    .on('crontab')
    .columns(['enabled', 'next_activation'])
    .execute();
}

export async function down(trx: Kysely<any>): Promise<void> {
  await trx.schema.dropTable('crontab').execute();
}
