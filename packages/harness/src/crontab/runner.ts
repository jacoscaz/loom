
import { type InitContext, WithContext } from '../context.js';
import { type Logger } from 'pinetto';
import { errToString, ellipsis } from '@loom/utils';
import { type SelectableCrontabRow } from '../database/tables/crontab.js';
import { HEARTBEAT_CADENCE, nextActivation } from './cadence.js';
import { executeHook, evaluateMatch, truncateOutput, type HookCaps } from './exec.js';
import { type TextBlock } from '../types/blocks.js';
import { type UserCrontabFiredNotification } from '../types/notifications.js';

/**
 * CrontabRunner — the resident scan loop that gives the heartbeat sensor
 * organs (design of record: coord 8-2026-10-05-heartbeat-polling-hooks,
 * design CLOSED 2026-10-05 10:55 UTC+2 with Jacopo).
 *
 * Two trigger paths, owned by row shape:
 *
 * - Cron rows (next_activation NOT NULL): process-time. This loop scans
 *   every minute for due rows and fires them whether the agent is
 *   present or not — sensors on the clock. Firing = claim (recompute
 *   next-after-NOW BEFORE executing, so a slow command can never leave a
 *   past-due next_activation that refires every tick) → execute with
 *   mechanical caps → record last_fired_at/last_output → inject into the
 *   weave as an inbound event via the notification bus (which wakes the
 *   session: a process-time sensor's whole point is to be heard).
 *
 * - @heartbeat rows (next_activation NULL): agent-time. Skipped by this
 *   loop; dispatched by the heartbeat path when the agent activates.
 *   Presence-tied: fired during heartbeat activations, results injected
 *   as event messages that never wake the session on their own.
 *
 * Double-fire protection is the harness's single-instance pid guard:
 * only one loom process ever runs this loop.
 */

const SCAN_INTERVAL_MS = 60_000;

export class CrontabRunner extends WithContext {

  #logger: Logger;
  #scan_timer: NodeJS.Timeout | null = null;
  #scanning = false;
  #dispatching = false;

  constructor(init: InitContext) {
    super(init);
    this.#logger = init.logger.child('[crontab]');
  }

  get #caps(): HookCaps {
    const c = this._ctx.config.crontab;
    return {
      timeout_ms: c?.timeout_ms ?? 60_000,
      max_output_bytes: c?.max_output_bytes ?? 8192,
    };
  }

  initialize(): void {
    if (this.#scan_timer) return;
    this.#scan_timer = setInterval(() => {
      this.#tick().catch(err => this.#logger.error('scan tick error: %s', errToString(err)));
    }, SCAN_INTERVAL_MS);
    this.#logger.info('crontab scan loop live (every %ds)', SCAN_INTERVAL_MS / 1000);
  }

  async #tick(): Promise<void> {
    if (this.#scanning) return;
    this.#scanning = true;
    try {
      const due = await this._ctx.db
        .selectFrom('crontab')
        .where('enabled', '=', true)
        .where('next_activation', 'is not', null)
        .where('next_activation', '<=', new Date())
        .selectAll()
        .execute();
      if (due.length === 0) return;
      this.#logger.info('scan: %d due hook(s)', due.length);
      for (const row of due) {
        try {
          await this.#fire(row);
        } catch (err) {
          this.#logger.error('hook \'%s\' fire error: %s', row.name, errToString(err));
        }
      }
    } finally {
      this.#scanning = false;
    }
  }

  async #fire(row: SelectableCrontabRow): Promise<void> {
    const now = new Date();

    // Claim first: next-after-NOW recomputed and stored BEFORE executing.
    // Downtime catch-up is therefore exactly one late firing per due row,
    // never a burst of every missed slot since the gap.
    const claimed = nextActivation(row.cadence, now);
    await this._ctx.db
      .updateTable('crontab')
      .set({ next_activation: claimed })
      .where('id', '=', row.id)
      .execute();

    const result = await executeHook(row.command, this.#caps);
    await this._ctx.db
      .updateTable('crontab')
      .set({ last_fired_at: now, last_output: truncateOutput(result.output, this.#caps.max_output_bytes) })
      .where('id', '=', row.id)
      .execute();

    this.#logger.info(
      'hook \'%s\' fired (%s, %d chars output)',
      row.name,
      result.timed_out ? 'TIMED OUT' : `exit ${result.exit_code ?? 'signal'}`,
      result.output.length,
    );

    if (!row.notify) return;
    if (!evaluateMatch(row.match, result.output)) return;

    const notification: UserCrontabFiredNotification = {
      role: 'user',
      type: 'notification',
      method: 'crontab/fired',
      hook_name: row.name,
      exit_code: result.exit_code,
      timed_out: result.timed_out,
      blocks: this.#resultBlocks(row, result),
    };
    await this._ctx.buses.notifications.notify(notification);
  }

  /**
   * Heartbeat-path dispatch: fire all enabled @heartbeat rows. Called by
   * the session runner at each heartbeat ACTIVATION (the injected prompt
   * moment — presence, not the 30s internal tick). Results are injected
   * as event messages (run: false): they ride the current or next
   * activation, never waking the session by themselves.
   */
  async dispatchHeartbeatDue(): Promise<void> {
    if (this.#dispatching) return;
    this.#dispatching = true;
    try {
      const rows = await this._ctx.db
        .selectFrom('crontab')
        .where('enabled', '=', true)
        .where('cadence', '=', HEARTBEAT_CADENCE)
        .selectAll()
        .execute();
      if (rows.length === 0) return;

      const main_session_id = this._ctx.managers.sessions.main_session_id;
      for (const row of rows) {
        try {
          const now = new Date();
          const result = await executeHook(row.command, this.#caps);
          await this._ctx.db
            .updateTable('crontab')
            .set({ last_fired_at: now, last_output: truncateOutput(result.output, this.#caps.max_output_bytes) })
            .where('id', '=', row.id)
            .execute();
          this.#logger.info(
            'hook \'%s\' fired on heartbeat (%s, %d chars output)',
            row.name,
            result.timed_out ? 'TIMED OUT' : `exit ${result.exit_code ?? 'signal'}`,
            result.output.length,
          );
          if (!row.notify) continue;
          if (!evaluateMatch(row.match, result.output)) continue;
          await this._ctx.managers.sessions.injectEventMessage(
            main_session_id,
            'crontab',
            this.#resultText(row, result),
            false,
          );
        } catch (err) {
          this.#logger.error('hook \'%s\' heartbeat fire error: %s', row.name, errToString(err));
        }
      }
    } finally {
      this.#dispatching = false;
    }
  }

  #resultBlocks(row: SelectableCrontabRow, result: { exit_code: number | null; timed_out: boolean; output: string }): TextBlock[] {
    const status = result.timed_out ? 'TIMED OUT' : `exit code ${result.exit_code ?? 'signal'}`;
    const body = [
      `⏰ CRONTAB — hook '${row.name}' fired (cadence: ${row.cadence}) — ${status}`,
      '',
      result.output ? ellipsis(result.output, 2000, '\n…[truncated — full output in the crontab row]') : '(no output)',
    ].join('\n');
    return [{ type: 'text', text: body }];
  }

  #resultText(row: SelectableCrontabRow, result: { exit_code: number | null; timed_out: boolean; output: string }): string {
    const status = result.timed_out ? 'TIMED OUT' : `exit code ${result.exit_code ?? 'signal'}`;
    return [
      `[crontab:heartbeat] hook '${row.name}' fired — ${status}`,
      result.output ? ellipsis(result.output, 2000, '\n…[truncated — full output in the crontab row]') : '(no output)',
    ].join('\n');
  }

}
