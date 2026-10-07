// Cloud service entry point.
//   Production (Supabase/PostgreSQL): DATABASE_URL + DATABASE_CA_CERT_FILE
//   Local development: no DATABASE_URL → embedded PGlite stored in CLOUD_DATA_DIR (default ./cloud-data)
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.js';
import { buildCloudApp } from './app.js';
import { pgSql, pgliteSql, type Sql } from './sql.js';
import { migrateCloud } from './store.js';

if (fs.existsSync(path.join(PROJECT_ROOT, '.env'))) process.loadEnvFile(path.join(PROJECT_ROOT, '.env'));

export async function openCloudDb(env = process.env): Promise<Sql> {
  if (env.DATABASE_URL) {
    return pgSql(env.DATABASE_URL, { caCertFile: env.DATABASE_CA_CERT_FILE, allowInsecureTls: env.DATABASE_ALLOW_UNVERIFIED_TLS === 'true' });
  }
  const dir = path.resolve(PROJECT_ROOT, env.CLOUD_DATA_DIR ?? 'cloud-data');
  return pgliteSql(dir);
}

async function main() {
  const sql = await openCloudDb();
  const applied = await migrateCloud(sql);
  const app = await buildCloudApp(sql, { trustProxy: process.env.TRUST_PROXY === 'true' });
  if (applied.length) app.log.info(`Cloud migrations applied: ${applied.join(', ')}`);
  const shutdown = async () => { await app.close(); await sql.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.CLOUD_PORT ?? process.env.PORT ?? 9090) });
}

if (process.argv[1] && path.resolve(process.argv[1]).replace(/\.(ts|js)$/, '') === path.resolve(import.meta.filename).replace(/\.(ts|js)$/, '')) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
