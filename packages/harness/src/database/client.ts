
import type { Tables } from './tables.js';

import { IsolationLevel, Kysely, sql, Transaction } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres from 'postgres';
import { type ConfigPostgres } from '../config/config.js';
import { decodeJson, encodeJson } from './json.js';

export { sql };

export type DB = Kysely<Tables> | Transaction<Tables>;

export const getDB = (opts: ConfigPostgres): Kysely<Tables> => {
  const dialect_client = postgres({
    database: opts.database,
    username: opts.username,
    password: opts.password,
    hostname: opts.hostname,
    port: opts.port,
    // Unqualified table names (ours and Kysely's migration bookkeeping)
    // resolve to the configured schema. See migrateToLatest().
    connection: opts.schema ? { search_path: opts.schema } : {},
    onnotice: () => {},
    types: {
      timestamp: {
        to: 1114,
        from: [1114],
        serialize: (v: string) => v,
        parse: (v: string) => v,
      },
      timestamptz: {
        to: 1184,
        from: [1184],
        serialize: (v: Date) => v.toISOString(),
        parse: (v: string) => new Date(v),
      },
      jsonb: {
        to: 3802,
        from: [3802],
        serialize: (v: any) => encodeJson(v),
        parse: (v: string) => decodeJson(v),
      },
      json: {
        to: 114,
        from: [114],
        serialize: (v: any) => encodeJson(v),
        parse: (v: string) => decodeJson(v),
      },
      bigint: {
        to: 20,
        from: [20],
        serialize: (v: number) => {
          if (v < Number.MIN_SAFE_INTEGER || v > Number.MAX_SAFE_INTEGER) {
            throw new Error(`Value ${v} out of range for the number type`);
          }
          return v.toString();
        },
        parse: (v: string) => {
          const raw = BigInt(v);
          if (raw < Number.MIN_SAFE_INTEGER || raw > Number.MAX_SAFE_INTEGER) {
            throw new Error(`Value ${v} out of range for the number type`);
          }
          return Number(raw);
        },
      },
    },
  });
  return new Kysely<Tables>({
    dialect: new PostgresJSDialect({
      postgres: dialect_client,
    }),
  });
};

export const isTrx = (db: DB): db is Transaction<Tables> => {
  return db instanceof Transaction;
};

export const ensureNoTrx = (db: DB): Kysely<Tables> => {
  if (isTrx(db)) {
    throw new Error('transaction');
  }
  return db;
};

export const ensureTrx = async <T>(db: DB, callback: (trx: Transaction<Tables>) => Promise<T>, isolationLevel?: IsolationLevel): Promise<T> => {
  if (isTrx(db)) {
    return await callback(db);
  }
  let trx = db.transaction();
  if (isolationLevel) {
    trx = trx.setIsolationLevel(isolationLevel);
  }
  return await trx.execute(callback);
};
