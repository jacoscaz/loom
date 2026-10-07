
import { type CompleteContext } from "../../context.js";
import { ellipsis, errToString } from "@loom/utils";
import { HEARTBEAT_CADENCE, nextActivation, parseCadence } from "../../crontab/cadence.js";
import { truncateOutput } from "../../crontab/exec.js";
import { type NewCrontabRow, type SelectableCrontabRow } from "../../database/tables/crontab.js";
import { type TextBlock } from "../../types/blocks.js";

// Crontab tools — the authoring surface for heartbeat sensor organs
// (design of record: coord 8-2026-10-05-heartbeat-polling-hooks).
//
// Division of labor: hooks are SENSORS, not actuators — they detect and
// signal; action stays in the agent's normal tool context where judgment
// lives. These tools own the WRITE boundary: cadences and match regexes
// are validated fail-fast here, at composition time, so bad shapes die
// at the boundary instead of silently at scan time (anchor #49: structure,
// not the periphery of attention).
//
// Execution itself is the runner's (src/crontab/runner.ts): mechanical
// caps live there, never in the command string.

const text = (s: string): TextBlock[] => [{ type: 'text', text: s }];

/** Normalize a cadence to its stored form: trimmed, @heartbeat lowercase. */
const normalizeCadence = (cadence: string): string => {
  const trimmed = cadence.trim();
  return trimmed.toLowerCase() === HEARTBEAT_CADENCE ? HEARTBEAT_CADENCE : trimmed;
};

/** Fail-fast validation shared by create and update. Returns an error string or null. */
const validateCadence = (cadence: string): string | null => {
  try {
    parseCadence(cadence);
    return null;
  } catch (err) {
    return `Invalid cadence '${cadence}': ${errToString(err)}. Use a cron expression (5-field, cron-schedule semantics, e.g. '*/15 * * * *') or the '@heartbeat' token.`;
  }
};

const validateMatch = (match: string | undefined): string | null => {
  if (match === undefined) return null;
  try {
    new RegExp(match);
    return null;
  } catch (err) {
    return `Invalid match regex: ${errToString(err)}`;
  }
};

const formatRow = (row: SelectableCrontabRow): string => [
  `#${row.id} '${row.name}' — cadence: ${row.cadence}${row.enabled ? '' : ' [DISABLED]'}`,
  `  command: ${ellipsis(row.command, 200, '…')}`,
  `  match: ${row.match ?? '(always inject)'} · notify: ${row.notify ? 'yes' : 'no (silent sensor)'}`,
  `  next_activation: ${row.next_activation ? row.next_activation.toISOString() : 'null (heartbeat path)'} · last_fired_at: ${row.last_fired_at ? row.last_fired_at.toISOString() : 'never'}`,
  row.last_output ? `  last_output: ${ellipsis(row.last_output, 300, '…')}` : '  last_output: (none)',
].join('\n');

export const initCrontabTools = (ctx: CompleteContext) => {

  ctx.managers.tools.add<{
    name: string;
    cadence: string;
    command: string;
    /** Optional regex against combined output: inject only on match. Validated at create. */
    match?: string;
    /** Whether firings inject into the weave. Default true. */
    notify?: boolean;
    /** Default true. */
    enabled?: boolean;
  }>(
    'crontab_create',
    'Create Crontab Hook',
    'Create a hook: a SENSOR that runs a shell command on a cadence and injects its output into the weave as an event. Sensors detect and signal; actuation stays in your own tool context. Cadence: a cron expression (5-field, e.g. "*/15 * * * *", server-local timezone — wall-clock-precise work belongs to systemd, not here) or the "@heartbeat" token (fires at each heartbeat activation). Commands run with mechanical caps (wall-clock timeout + ulimits, config.crontab). The next activation time is computed from the cadence at create and recomputed by the runner after each firing (next-after-now: downtime catch-up is one late firing, never a burst).',
    true,
    async (params, call_ctx) => {
      const db = call_ctx.db;
      const cadence = normalizeCadence(params.cadence);
      const err = validateCadence(cadence) ?? validateMatch(params.match);
      if (err) return text(`Error: ${err}`);
      const name = params.name.trim();
      if (!name) return text('Error: name must be non-empty');
      try {
        const values: NewCrontabRow = {
          name,
          cadence,
          command: params.command,
          match: params.match ?? null,
          notify: params.notify ?? true,
          enabled: params.enabled ?? true,
          next_activation: nextActivation(cadence, new Date()),
          created_at: new Date(),
        };
        await db.insertInto('crontab').values(values).execute();
      } catch (e: any) {
        if (e?.code === '23505') return text(`Error: a hook named '${name}' already exists (use crontab_update or pick another name)`);
        return text(`Error: ${errToString(e)}`);
      }
      const row = await db.selectFrom('crontab').where('name', '=', name).selectAll().executeTakeFirstOrThrow();
      return text(`Hook created.\n\n${formatRow(row)}`);
    },
  );

  ctx.managers.tools.add<{
    id: number;
    cadence?: string;
    command?: string;
    match?: string;
    notify?: boolean;
    enabled?: boolean;
  }>(
    'crontab_update',
    'Update Crontab Hook',
    'Update a hook by id. Changing cadence revalidates it (fail-fast) and recomputes next_activation from now; enabling a hook likewise recomputes next_activation from now, so re-enabling never fires a stale slot. Set match to a regex to gate injections on the output, or to null (JSON null) to always inject. The runner never hand-syncs derived state: every cadence/enable change recomputes next_activation here.',
    true,
    async (params, call_ctx) => {
      const db = call_ctx.db;
      const row = await db.selectFrom('crontab').where('id', '=', params.id).selectAll().executeTakeFirst();
      if (!row) return text(`Error: no hook with id ${params.id}`);

      if (params.cadence !== undefined) {
        const err = validateCadence(params.cadence);
        if (err) return text(`Error: ${err}`);
      }
      if (params.match !== undefined && params.match !== null) {
        const err = validateMatch(params.match);
        if (err) return text(`Error: ${err}`);
      }

      // Recompute next_activation whenever the cadence or the enabled
      // state changes: derived state matches source, never hand-synced.
      const cadence = params.cadence !== undefined ? normalizeCadence(params.cadence) : row.cadence;
      const enabled = params.enabled ?? row.enabled;
      const recompute = params.cadence !== undefined || (params.enabled !== undefined && params.enabled !== row.enabled);
      const next_activation = recompute ? nextActivation(cadence, new Date()) : row.next_activation;

      await db.updateTable('crontab').set({
        cadence,
        enabled,
        next_activation,
        command: params.command ?? row.command,
        match: params.match === undefined ? row.match : params.match,
        notify: params.notify ?? row.notify,
        updated_at: new Date(),
      }).where('id', '=', params.id).execute();

      const updated = await db.selectFrom('crontab').where('id', '=', params.id).selectAll().executeTakeFirstOrThrow();
      return text(`Hook updated.\n\n${formatRow(updated)}`);
    },
  );

  ctx.managers.tools.add<{
    id: number;
  }>(
    'crontab_delete',
    'Delete Crontab Hook',
    'Delete a hook by id. Revocation of a sensor is deletion: the row goes, the runner stops firing it. Execution history (last_output) goes with it — export anything worth keeping first.',
    true,
    async (params, call_ctx) => {
      const deleted = await call_ctx.db.deleteFrom('crontab').where('id', '=', params.id).executeTakeFirst();
      return deleted.numDeletedRows > 0n
        ? text(`Hook #${params.id} deleted.`)
        : text(`Error: no hook with id ${params.id}`);
    },
  );

  ctx.managers.tools.add<{}>(
    'crontab_list',
    'List Crontab Hooks',
    'List all hooks with their state: cadence, command, match gate, notify flag, next_activation, last firing and last output. The audit view of your sensorium — read this before editing.',
    true,
    async (_params, call_ctx) => {
      const rows = await call_ctx.db.selectFrom('crontab').selectAll().orderBy('name', 'asc').execute();
      if (rows.length === 0) return text('No hooks. The sensorium is empty — crontab_create to grow one.');
      return text(rows.map(formatRow).join('\n\n'));
    },
  );

};
