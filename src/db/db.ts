// Opens the branch SQLite database with durable settings and applies migrations.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PROJECT_ROOT } from '../config.js';
import { newId, nowIso } from '../lib/core.js';

export type DB = Database.Database;

const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'src', 'db', 'migrations');

export function listMigrations(): { name: string; sql: string }[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
}

export class SchemaTooNewError extends Error {}

export function migrate(db: DB): { applied: string[] } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const known = listMigrations();
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all() as string[]);
  const unknown = [...done].filter((n) => !known.some((k) => k.name === n));
  if (unknown.length) {
    // The data was written by a newer version of the software. Refuse rather than risk damage.
    throw new SchemaTooNewError(
      `Database schema is newer than this application (unknown migrations: ${unknown.join(', ')}). ` +
        `Install the matching or newer application version.`,
    );
  }
  const applied: string[] = [];
  for (const m of known) {
    if (done.has(m.name)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(m.name, nowIso());
    }).immediate();
    applied.push(m.name);
  }
  return { applied };
}

export function openDatabase(file: string, opts: { migrate?: boolean } = {}): DB {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL'); // durability over raw speed: a committed payment survives power loss
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (opts.migrate !== false) {
    migrate(db);
    if (!db.prepare('SELECT id FROM node_identity').get()) {
      db.prepare('INSERT INTO node_identity (id, created_at) VALUES (?, ?)').run(newId(), nowIso());
    }
  }
  return db;
}

/** Run fn in an IMMEDIATE transaction (takes the write lock up front, so check-then-write is atomic). */
export function tx<T>(db: DB, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export function schemaVersion(db: DB): number {
  return (db.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get() as number) ?? 0;
}
