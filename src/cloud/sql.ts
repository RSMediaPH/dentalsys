// Minimal PostgreSQL access layer for the cloud service.
// Production: `pg` against Supabase (or any PostgreSQL). Tests/local dev: PGlite (PostgreSQL in WASM).
import fs from 'node:fs';
import pg from 'pg';

export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  exec(text: string): Promise<void>;
  transaction<T>(fn: (q: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function pgSql(connectionString: string, opts: { caCertFile?: string; allowInsecureTls?: boolean } = {}): Sql {
  let ssl: pg.PoolConfig['ssl'];
  if (opts.caCertFile) ssl = { ca: fs.readFileSync(opts.caCertFile, 'utf8'), rejectUnauthorized: true };
  else if (opts.allowInsecureTls) ssl = { rejectUnauthorized: false };
  else if (!/localhost|127\.0\.0\.1/.test(connectionString)) {
    throw new Error('Set DATABASE_CA_CERT_FILE to the database CA certificate (Supabase: Project Settings → Database → SSL). Refusing an unverified TLS connection.');
  }
  const pool = new pg.Pool({ connectionString, ssl, max: 10 });
  const wrap = (c: pg.Pool | pg.PoolClient): Sql => ({
    query: async (text, params) => (await c.query(text, params as unknown[])).rows,
    exec: async (text) => { await c.query(text); },
    transaction: async () => { throw new Error('nested transactions are not supported'); },
    close: async () => {},
  });
  return {
    ...wrap(pool),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await fn(wrap(client));
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function pgliteSql(dataDir?: string): Promise<Sql> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  type Q = { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }>; exec: (t: string) => Promise<unknown> };
  const wrap = (c: Q): Sql => ({
    query: async <T>(text: string, params?: unknown[]) => (await c.query(text, params)).rows as T[],
    exec: async (text) => { await c.exec(text); },
    transaction: async () => { throw new Error('nested transactions are not supported'); },
    close: async () => {},
  });
  return {
    ...wrap(db as unknown as Q),
    transaction: (fn) => db.transaction((t) => fn(wrap(t as unknown as Q))),
    close: () => db.close(),
  };
}
