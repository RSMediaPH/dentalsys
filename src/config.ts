// Runtime configuration from environment variables (see .env.example).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', ...(
  fileURLToPath(import.meta.url).includes(`${path.sep}dist${path.sep}`) ? ['..'] : []
));

const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string };
export const APP_VERSION: string = pkg.version;
/** Bumped when the branch↔cloud sync contract changes (Milestone 2). */
export const SYNC_PROTOCOL_VERSION = 1;
/** Payload schema version stamped on every outbox event. */
export const EVENT_SCHEMA_VERSION = 1;

export interface Config {
  dataDir: string;
  dbFile: string;
  attachmentsDir: string;
  backupDir: string;
  backupKeyFile: string;
  backupRetention: number;
  backupDailyAt: string | null; // "HH:mm" server-local, null = disabled
  host: string;
  port: number;
  tlsCertFile: string | null;
  tlsKeyFile: string | null;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  cookieSecure: boolean;
  trustProxy: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(PROJECT_ROOT, env.DATA_DIR ?? 'data');
  const tlsCertFile = env.TLS_CERT_FILE || null;
  return {
    dataDir,
    dbFile: path.join(dataDir, 'branch.db'),
    attachmentsDir: path.join(dataDir, 'attachments'),
    backupDir: path.resolve(PROJECT_ROOT, env.BACKUP_DIR ?? path.join(dataDir, 'backups')),
    backupKeyFile: path.resolve(PROJECT_ROOT, env.BACKUP_KEY_FILE ?? path.join(dataDir, 'keys', 'backup.key')),
    backupRetention: Math.max(1, Number(env.BACKUP_RETENTION ?? 14)),
    backupDailyAt: env.BACKUP_DAILY_AT === '' ? null : (env.BACKUP_DAILY_AT ?? '21:00'),
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 8080),
    tlsCertFile,
    tlsKeyFile: env.TLS_KEY_FILE || null,
    sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES ?? 60),
    sessionAbsoluteHours: Number(env.SESSION_ABSOLUTE_HOURS ?? 12),
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : Boolean(tlsCertFile),
    trustProxy: env.TRUST_PROXY === 'true',
  };
}
