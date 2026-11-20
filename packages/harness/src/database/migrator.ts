import path, { resolve } from 'path'
import fs from 'fs/promises'
import {
  Migrator,
  FileMigrationProvider
} from 'kysely/migration';
import { type DB, ensureNoTrx, sql } from './client.js';

interface MigrationLogger {
  debug(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

/**
 * Brings the database up to date. When `schema` is given it is created if
 * missing; the connection's search_path (see getDB()) makes every
 * unqualified table, including Kysely's migration bookkeeping, live there.
 */
export const migrateToLatest = async (db: DB, logger: MigrationLogger, schema?: string) => {

  if (schema) {
    await sql`CREATE SCHEMA IF NOT EXISTS ${sql.id(schema)}`.execute(db);
  }

  const migrator = new Migrator({
    db: ensureNoTrx(db),
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: resolve(import.meta.dirname, 'migrations'),
    }),
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((it) => {
    if (it.status === 'Success') {
      logger.debug('migration %s was executed successfully', it.migrationName);
    } else if (it.status === 'Error') {
      logger.error('failed to execute migration %s', it.migrationName);
    }
  });

  if (error) {
    throw error;
  }

};
