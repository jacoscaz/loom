import { randomBytes } from 'node:crypto';
import { getDB, sql } from '../database/client.js';
import { migrateToLatest } from '../database/migrator.js';
import type { ConfigPostgres } from '../config/config.js';
import { DatabaseHistoryStore } from './database.js';
import { historyStoreContract } from './store.contract.js';

/**
 * Runs against a real Postgres when LOOM_TEST_POSTGRES_URL is set, e.g.
 * postgres://loom:loom@127.0.0.1:5432/loom. Every test runs in its own
 * throwaway schema, dropped afterwards: no existing table is touched.
 */
const url = process.env.LOOM_TEST_POSTGRES_URL;

const configFromUrl = (raw: string, schema: string): ConfigPostgres => {
  const u = new URL(raw);
  return {
    hostname: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    username: decodeURIComponent(u.username) || undefined,
    password: decodeURIComponent(u.password) || undefined,
    database: u.pathname.replace(/^\//, ''),
    schema,
  };
};

const silent = { debug: () => {}, error: () => {} };

historyStoreContract('postgres', async () => {
  const schema = `loom_test_${randomBytes(6).toString('hex')}`;
  const config = configFromUrl(url!, schema);
  const db = getDB(config);
  await migrateToLatest(db, silent, schema);
  return {
    store: new DatabaseHistoryStore(db),
    teardown: async () => {
      await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(db);
      await db.destroy();
    },
  };
}, { skip: url ? false : 'set LOOM_TEST_POSTGRES_URL to run against Postgres' });
