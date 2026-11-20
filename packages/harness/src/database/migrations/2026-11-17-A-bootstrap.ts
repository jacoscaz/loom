
import { sql, Kysely } from 'kysely';

/**
 * Fresh schema for the @loom/proto-based harness. Not compatible with the
 * previous harness' schema: point the harness at an empty database or at
 * a dedicated schema (see `postgres.schema`).
 */
export async function up(db: Kysely<any>): Promise<void> {

  await db.schema.createTable('sessions')
    .addColumn('id', 'text', col => col.primaryKey())
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createTable('messages')
    .addColumn('id', 'bigserial', col => col.primaryKey())
    .addColumn('session_id', 'text', col => col.notNull().references('sessions.id').onDelete('cascade'))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('processed_at', 'timestamptz')
    .addColumn('role', 'text', col => col.notNull().check(sql`role in ('user', 'agent')`))
    .addColumn('blocks', 'jsonb', col => col.notNull())
    .execute();

  // History order: see selectHistory().
  await db.schema.createIndex('messages_history_idx')
    .on('messages')
    .columns(['session_id', 'processed_at', 'id'])
    .execute();

  await db.schema.createIndex('messages_unprocessed_idx')
    .on('messages')
    .column('session_id')
    .where(sql.ref('processed_at'), 'is', null)
    .execute();

}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('messages').execute();
  await db.schema.dropTable('sessions').execute();
}
