// Hosted demo support: seed synthetic data on first start, and wipe/reseed nightly.
// Every destructive step is guarded: demo mode must be on AND the only organization must be the demo one.
import fs from 'node:fs';
import { DateTime } from 'luxon';
import type { Config } from './config.js';
import type { DB } from './db/db.js';
import { seedDemo, DEMO_ORG_NAME } from './cli/seed-demo.js';
import { generateKeyFile } from './backup/backup.js';

export function isDemoDatabase(db: DB): boolean {
  const orgs = db.prepare('SELECT name FROM organizations').pluck().all() as string[];
  return orgs.length === 1 && orgs[0] === DEMO_ORG_NAME;
}

/** Seed synthetic data if the database is empty. Returns true if it seeded. */
export async function ensureDemoData(db: DB, cfg: Config, password: string | undefined): Promise<boolean> {
  if (!cfg.demoMode) return false;
  if (db.prepare('SELECT 1 FROM organizations').get()) return false;
  if (!password) throw new Error('DEMO_MODE is on but DEMO_PASSWORD is not set; refusing to create demo accounts.');
  await seedDemo(db, password);
  if (!fs.existsSync(cfg.backupKeyFile)) generateKeyFile(cfg.backupKeyFile);
  return true;
}

/** True when the daily reset time (org timezone) has passed since this database was created. */
export function demoResetDue(db: DB, cfg: Config, now: DateTime = DateTime.now()): boolean {
  if (!cfg.demoMode || !cfg.demoResetDailyAt || !isDemoDatabase(db)) return false;
  const tz = db.prepare('SELECT default_timezone FROM organizations').pluck().get() as string;
  const [hh, mm] = cfg.demoResetDailyAt.split(':').map(Number);
  const local = now.setZone(tz);
  let due = local.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
  if (local < due) due = due.minus({ days: 1 });
  const createdAt = db.prepare('SELECT created_at FROM node_identity').pluck().get() as string;
  return DateTime.fromISO(createdAt) < due;
}

/** Delete the demo database files. The hosting platform restarts the process, which reseeds. */
export function wipeDemoData(db: DB, cfg: Config): void {
  if (!cfg.demoMode || !isDemoDatabase(db)) throw new Error('Refusing to wipe: not a demo database.');
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(cfg.dbFile + suffix, { force: true });
  fs.rmSync(cfg.attachmentsDir, { recursive: true, force: true });
}
