// Branch server entry point: opens the database, starts the web app and the backup scheduler.
import fs from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { loadConfig, PROJECT_ROOT } from './config.js';
import { openDatabase, type DB } from './db/db.js';
import { buildApp } from './web/app.js';
import { runBackup } from './backup/backup.js';
import type { Config } from './config.js';

if (fs.existsSync(path.join(PROJECT_ROOT, '.env'))) process.loadEnvFile(path.join(PROJECT_ROOT, '.env'));

/** Run the daily backup once per day after the configured time; retry failures every 30 minutes. */
export function startBackupScheduler(db: DB, cfg: Config, log: (msg: string) => void): NodeJS.Timeout | null {
  if (!cfg.backupDailyAt) return null;
  const [hh, mm] = cfg.backupDailyAt.split(':').map(Number);
  let running = false;
  const tick = async () => {
    if (running) return;
    const now = DateTime.local();
    const due = now.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
    if (now < due) return;
    const dueIso = due.toUTC().toISO()!;
    const done = db.prepare(`SELECT 1 FROM backup_runs WHERE kind = 'scheduled' AND status = 'succeeded' AND started_at >= ?`).get(dueIso);
    if (done) return;
    const recentFail = db.prepare(`SELECT 1 FROM backup_runs WHERE kind = 'scheduled' AND status = 'failed' AND started_at >= ?`)
      .get(now.minus({ minutes: 30 }).toUTC().toISO());
    if (recentFail) return;
    running = true;
    try {
      const r = await runBackup(db, cfg, 'scheduled', null);
      log(`Scheduled backup completed and verified: ${path.basename(r.file)}`);
    } catch (e) {
      log(`Scheduled backup FAILED: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  return setInterval(() => void tick(), 60_000);
}

async function main() {
  const cfg = loadConfig();
  fs.mkdirSync(cfg.attachmentsDir, { recursive: true });
  const db = openDatabase(cfg.dbFile);
  const app = await buildApp({ db, cfg });
  const timer = startBackupScheduler(db, cfg, (m) => app.log.info(m));
  const shutdown = async () => {
    if (timer) clearInterval(timer);
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await app.listen({ host: cfg.host, port: cfg.port });
  app.log.info(`Clinic server ready on ${cfg.tlsCertFile ? 'https' : 'http'}://${cfg.host}:${cfg.port} (data: ${cfg.dataDir})`);
}

if (process.argv[1] && path.resolve(process.argv[1]).replace(/\.(ts|js)$/, '') === path.resolve(import.meta.filename).replace(/\.(ts|js)$/, '')) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
