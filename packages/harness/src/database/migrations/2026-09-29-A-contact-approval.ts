
import { Kysely } from 'kysely';

/**
 * Contact approval (2026-09-29, with Jacopo): the agent gains contact
 * management tools, so existence can no longer imply vouching. The
 * `approved` column is the operator's alone — it is deliberately NOT
 * settable through any contact tool. Verification (ContactsManager.lookup)
 * requires existence AND approval; unapproved entries resolve to the
 * same do-not-trust resting state as unknown senders.
 *
 * Backfill: every row present at migration time was authored by the
 * operator before agent-facing contact tools existed — their provenance
 * is genuine, so they carry approved = true. Contacts created THROUGH
 * the new tools default to false.
 */
export async function up(trx: Kysely<any>): Promise<void> {
  await trx.schema.alterTable('contacts')
    .addColumn('approved', 'boolean', col => col.notNull().defaultTo(false))
    .execute();
  await trx.updateTable('contacts')
    .set({ approved: true })
    .execute();
}

export async function down(trx: Kysely<any>): Promise<void> {
  await trx.schema.alterTable('contacts')
    .dropColumn('approved')
    .execute();
}
