// Encrypted backups and non-destructive restore.
//
// Archive (.dcmbak) = header + sequence of AES-256-GCM chunks.
//   header (32 bytes): "DCMBAK01" | salt(16) | noncePrefix(8)
//   key = HKDF-SHA256(masterKey, salt, "dcm-backup-v1")
//   chunk: final(1) | ctLen(u32BE) | ciphertext | tag(16); nonce = noncePrefix | u32BE(index);
//          AAD = header | u32BE(index) | final  → reordering, truncation and tampering are all detected.
// Plaintext inside = "DCMPLN01" | manifestLen(u32BE) | manifest JSON | file bytes in manifest order.
//
// Restore never touches the live data directory: it extracts into an EMPTY target directory, verifies
// checksums, SQLite integrity and record counts, and leaves switching over to the operator.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { APP_VERSION } from '../config.js';
import type { Config } from '../config.js';
import { listMigrations, type DB } from '../db/db.js';
import { newId, nowIso } from '../lib/core.js';

const MAGIC = Buffer.from('DCMBAK01');
const PLAIN_MAGIC = Buffer.from('DCMPLN01');
const CHUNK = 1024 * 1024;
const KEY_PREFIX = 'dcm-backup-key-v1:';
export const COUNTED_TABLES = ['patients', 'appointments', 'invoices', 'invoice_lines', 'payments', 'payment_reversals', 'audit_events', 'outbox_events'] as const;

export class BackupError extends Error {}

// ---------- Keys ----------
export function generateKeyFile(file: string): void {
  if (fs.existsSync(file)) throw new BackupError(`Key file already exists at ${file}; refusing to overwrite it.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, KEY_PREFIX + crypto.randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
}
export function readKeyFile(file: string): Buffer {
  if (!fs.existsSync(file)) throw new BackupError(`Backup key file not found at ${file}. Run "npm run backup:keygen" (first install) or restore the key from your safe copy.`);
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text.startsWith(KEY_PREFIX)) throw new BackupError('Backup key file is not in the expected format.');
  const key = Buffer.from(text.slice(KEY_PREFIX.length), 'base64');
  if (key.length !== 32) throw new BackupError('Backup key file is damaged (wrong length).');
  return key;
}
const keyFingerprint = (key: Buffer) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);

function deriveKey(master: Buffer, salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', master, salt, 'dcm-backup-v1', 32));
}
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

// ---------- Streaming encryptor ----------
class Encryptor {
  private pending: Buffer[] = [];
  private pendingLen = 0;
  private index = 0;
  private readonly key: Buffer;
  private readonly header: Buffer;
  readonly hash = crypto.createHash('sha256');
  bytes = 0;
  constructor(private readonly fd: number, master: Buffer) {
    const salt = crypto.randomBytes(16);
    const noncePrefix = crypto.randomBytes(8);
    this.header = Buffer.concat([MAGIC, salt, noncePrefix]);
    this.key = deriveKey(master, salt);
    this.write(this.header);
  }
  private write(b: Buffer) {
    fs.writeSync(this.fd, b);
    this.hash.update(b);
    this.bytes += b.length;
  }
  private emit(plain: Buffer, final: boolean) {
    const nonce = Buffer.concat([this.header.subarray(24, 32), u32(this.index)]);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, nonce);
    c.setAAD(Buffer.concat([this.header, u32(this.index), Buffer.from([final ? 1 : 0])]));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    this.write(Buffer.concat([Buffer.from([final ? 1 : 0]), u32(ct.length), ct, c.getAuthTag()]));
    this.index++;
  }
  push(b: Buffer) {
    this.pending.push(b);
    this.pendingLen += b.length;
    while (this.pendingLen > CHUNK) {
      const all = Buffer.concat(this.pending);
      this.emit(all.subarray(0, CHUNK), false);
      this.pending = [all.subarray(CHUNK)];
      this.pendingLen = all.length - CHUNK;
    }
  }
  finish() {
    this.emit(Buffer.concat(this.pending), true);
  }
}

// ---------- Streaming decryptor: yields plaintext chunks, throws on any tampering/truncation ----------
function* decryptChunks(file: string, master: Buffer): Generator<Buffer> {
  const fd = fs.openSync(file, 'r');
  try {
    const readExact = (n: number): Buffer | null => {
      const b = Buffer.alloc(n);
      let off = 0;
      while (off < n) {
        const r = fs.readSync(fd, b, off, n - off, null);
        if (r === 0) return off === 0 ? null : (() => { throw new BackupError('Backup archive is truncated.'); })();
        off += r;
      }
      return b;
    };
    const header = readExact(24 + 8);
    if (!header || !header.subarray(0, 8).equals(MAGIC)) throw new BackupError('Not a backup archive (bad header).');
    const key = deriveKey(master, header.subarray(8, 24));
    for (let index = 0; ; index++) {
      const meta = readExact(5);
      if (!meta) throw new BackupError('Backup archive is truncated (missing final chunk).');
      const final = meta[0] === 1;
      const len = meta.readUInt32BE(1);
      if (len > CHUNK + 16) throw new BackupError('Backup archive is corrupt (chunk too large).');
      const ct = readExact(len) ?? Buffer.alloc(0);
      const tag = readExact(16);
      if (!tag) throw new BackupError('Backup archive is truncated.');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.concat([header.subarray(24, 32), u32(index)]));
      d.setAAD(Buffer.concat([header, u32(index), Buffer.from([final ? 1 : 0])]));
      d.setAuthTag(tag);
      let plain: Buffer;
      try {
        plain = Buffer.concat([d.update(ct), d.final()]);
      } catch {
        throw new BackupError('Backup archive failed authentication: wrong key, or the file is damaged or was modified.');
      }
      yield plain;
      if (final) {
        if (readExact(1)) throw new BackupError('Backup archive has unexpected data after the final chunk.');
        return;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Pull exact byte counts out of the plaintext chunk stream. */
class PlainReader {
  private buf = Buffer.alloc(0);
  constructor(private readonly it: Generator<Buffer>) {}
  read(n: number): Buffer {
    while (this.buf.length < n) {
      const next = this.it.next();
      if (next.done) throw new BackupError('Backup content ended unexpectedly.');
      this.buf = Buffer.concat([this.buf, next.value]);
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  assertEnd() {
    if (this.buf.length || !this.it.next().done) throw new BackupError('Backup content has unexpected trailing data.');
  }
}

export interface Manifest {
  format: 1;
  created_at: string;
  app_version: string;
  migrations: string[];
  node_id: string;
  key_fingerprint: string;
  organizations: { id: string; name: string }[];
  branches: { id: string; code: string; name: string }[];
  counts: Record<string, number>;
  files: { path: string; size: number; sha256: string }[];
}

function listFiles(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}
const sha256File = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function countRows(dbFile: string): Record<string, number> {
  const d = new Database(dbFile, { readonly: true });
  try {
    return Object.fromEntries(COUNTED_TABLES.map((t) => [t, d.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get() as number]));
  } finally {
    d.close();
  }
}

export interface BackupResult { id: string; file: string; sizeBytes: number; sha256: string; manifest: Manifest; verified: boolean }

/** Create an encrypted backup of the database + attachments, then verify it by test-restoring to a temp dir. */
export async function runBackup(db: DB, cfg: Config, kind: 'scheduled' | 'manual', startedBy: string | null): Promise<BackupResult> {
  const id = newId();
  db.prepare(`INSERT INTO backup_runs (id, kind, started_at, status, started_by) VALUES (?, ?, ?, 'running', ?)`).run(id, kind, nowIso(), startedBy);
  const workDir = path.join(cfg.dataDir, `.backup-work-${id}`);
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cfg.backupDir, { recursive: true });
  const stamp = nowIso().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const branchCode = (db.prepare('SELECT code FROM branches ORDER BY created_at LIMIT 1').pluck().get() as string | undefined) ?? 'NODE';
  const fileName = `dcm-backup-${branchCode}-${stamp}-${id.slice(-8)}.dcmbak`;
  const finalPath = path.join(cfg.backupDir, fileName);
  const tmpPath = finalPath + '.partial';
  try {
    const master = readKeyFile(cfg.backupKeyFile);
    const snapshot = path.join(workDir, 'branch.db');
    await db.backup(snapshot); // consistent online snapshot; clinic work continues meanwhile
    const attachments = listFiles(cfg.attachmentsDir);
    const files = [
      { path: 'branch.db', abs: snapshot },
      ...attachments.map((p) => ({ path: `attachments/${p}`, abs: path.join(cfg.attachmentsDir, ...p.split('/')) })),
    ].map((f) => ({ ...f, size: fs.statSync(f.abs).size, sha256: sha256File(f.abs) }));

    const manifest: Manifest = {
      format: 1,
      created_at: nowIso(),
      app_version: APP_VERSION,
      migrations: db.prepare('SELECT name FROM schema_migrations ORDER BY name').pluck().all() as string[],
      node_id: db.prepare('SELECT id FROM node_identity').pluck().get() as string,
      key_fingerprint: keyFingerprint(master),
      organizations: db.prepare('SELECT id, name FROM organizations').all() as Manifest['organizations'],
      branches: db.prepare('SELECT id, code, name FROM branches').all() as Manifest['branches'],
      counts: countRows(snapshot),
      files: files.map(({ path: p, size, sha256 }) => ({ path: p, size, sha256 })),
    };

    const fd = fs.openSync(tmpPath, 'wx', 0o600);
    let enc: Encryptor;
    try {
      enc = new Encryptor(fd, master);
      const mj = Buffer.from(JSON.stringify(manifest));
      enc.push(Buffer.concat([PLAIN_MAGIC, u32(mj.length), mj]));
      for (const f of files) {
        const rfd = fs.openSync(f.abs, 'r');
        try {
          const buf = Buffer.alloc(CHUNK);
          let r: number;
          let total = 0;
          while ((r = fs.readSync(rfd, buf, 0, CHUNK, null)) > 0) {
            enc.push(Buffer.from(buf.subarray(0, r)));
            total += r;
          }
          if (total !== f.size) throw new BackupError(`File changed while backing up: ${f.path}`);
        } finally {
          fs.closeSync(rfd);
        }
      }
      enc.finish();
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, finalPath);
    const sha = enc.hash.digest('hex');

    // A backup that has not been test-restored is not trusted.
    const verifyDir = path.join(workDir, 'verify');
    restoreBackup(finalPath, cfg.backupKeyFile, verifyDir);

    db.prepare(`UPDATE backup_runs SET status = 'succeeded', finished_at = ?, file_name = ?, size_bytes = ?, sha256 = ?, verified_at = ? WHERE id = ?`)
      .run(nowIso(), fileName, enc.bytes, sha, nowIso(), id);
    applyRetention(db, cfg);
    return { id, file: finalPath, sizeBytes: enc.bytes, sha256: sha, manifest, verified: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare(`UPDATE backup_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`).run(nowIso(), msg.slice(0, 500), id);
    fs.rmSync(tmpPath, { force: true });
    throw e;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** Keep the newest N verified backups; remove older archive files this server created. */
export function applyRetention(db: DB, cfg: Config): string[] {
  const rows = db
    .prepare(`SELECT id, file_name FROM backup_runs WHERE status = 'succeeded' AND verified_at IS NOT NULL AND file_name IS NOT NULL ORDER BY started_at DESC`)
    .all() as { id: string; file_name: string }[];
  const removed: string[] = [];
  for (const r of rows.slice(cfg.backupRetention)) {
    const f = path.join(cfg.backupDir, path.basename(r.file_name));
    if (fs.existsSync(f)) {
      fs.rmSync(f);
      removed.push(r.file_name);
    }
    db.prepare(`UPDATE backup_runs SET file_name = NULL, error = 'Removed by retention policy' WHERE id = ?`).run(r.id);
  }
  return removed;
}

export interface RestoreReport { targetDir: string; manifest: Manifest; integrity: string; counts: Record<string, number>; filesVerified: number }

/**
 * Decrypt and extract an archive into an EMPTY directory, then verify it.
 * Never overwrites anything: refuses a non-empty target.
 */
export function restoreBackup(archive: string, keyFile: string, targetDir: string): RestoreReport {
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length) {
    throw new BackupError(`Restore target ${targetDir} is not empty. Restore always goes into a new, empty directory.`);
  }
  const master = readKeyFile(keyFile);
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const reader = new PlainReader(decryptChunks(archive, master));
  if (!reader.read(8).equals(PLAIN_MAGIC)) throw new BackupError('Backup content has an unknown format.');
  const manifest = JSON.parse(reader.read(reader.read(4).readUInt32BE(0)).toString('utf8')) as Manifest;
  if (manifest.format !== 1) throw new BackupError(`Unsupported backup format ${manifest.format}.`);

  const known = new Set(listMigrations().map((m) => m.name));
  const unknown = manifest.migrations.filter((m) => !known.has(m));
  if (unknown.length) throw new BackupError(`Backup was made by a newer application version (${manifest.app_version}). Install that version or newer to restore it.`);

  const root = path.resolve(targetDir);
  for (const f of manifest.files) {
    const dest = path.resolve(root, ...f.path.split('/'));
    if (!dest.startsWith(root + path.sep) || f.path.includes('\\')) throw new BackupError(`Unsafe path in backup: ${f.path}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(dest, 'wx', 0o600);
    try {
      let left = f.size;
      while (left > 0) {
        const part = reader.read(Math.min(left, CHUNK));
        h.update(part);
        fs.writeSync(fd, part);
        left -= part.length;
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (h.digest('hex') !== f.sha256) throw new BackupError(`Checksum mismatch for ${f.path}.`);
  }
  reader.assertEnd();

  const dbFile = path.join(root, 'branch.db');
  const d = new Database(dbFile);
  let integrity: string;
  try {
    integrity = d.prepare('PRAGMA integrity_check').pluck().get() as string;
    const fk = d.prepare('PRAGMA foreign_key_check').all();
    if (integrity !== 'ok') throw new BackupError(`Restored database failed integrity check: ${integrity}`);
    if (fk.length) throw new BackupError(`Restored database has ${fk.length} broken references.`);
  } finally {
    d.close();
  }
  const counts = countRows(dbFile);
  for (const t of Object.keys(manifest.counts)) {
    if (counts[t] !== manifest.counts[t]) throw new BackupError(`Restored ${t} count ${counts[t]} does not match backup manifest ${manifest.counts[t]}.`);
  }
  return { targetDir: root, manifest, integrity, counts, filesVerified: manifest.files.length };
}

export function backupOverview(db: DB, cfg: Config) {
  const runs = db.prepare('SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT 30').all() as {
    id: string; kind: string; started_at: string; finished_at: string | null; status: string; file_name: string | null; size_bytes: number | null; error: string | null; verified_at: string | null;
  }[];
  const lastSuccess = db.prepare(`SELECT MAX(finished_at) FROM backup_runs WHERE status = 'succeeded'`).pluck().get() as string | null;
  const sameDisk = path.resolve(cfg.backupDir).startsWith(path.resolve(cfg.dataDir));
  return { runs, lastSuccess, keyPresent: fs.existsSync(cfg.backupKeyFile), backupDir: cfg.backupDir, sameDisk, retention: cfg.backupRetention, dailyAt: cfg.backupDailyAt };
}
