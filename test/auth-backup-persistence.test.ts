import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Browser, cleanup, fixture, httpApp, PASSWORD, tempDir, type Fixture } from './helpers.js';
import { login, THROTTLE } from '../src/auth/auth.js';
import { deactivateMembership } from '../src/domain/orgs.js';
import { applyRetention, BackupError, generateKeyFile, restoreBackup, runBackup } from '../src/backup/backup.js';
import { openDatabase, SchemaTooNewError } from '../src/db/db.js';
import { clock, newId } from '../src/lib/core.js';
import { addLine, createDraftInvoice, getInvoice, issueInvoice, recordPayment } from '../src/domain/billing.js';
import { buildContext } from '../src/domain/context.js';

describe('authentication and sessions', () => {
  let f: Fixture;
  before(async () => { f = await fixture(); });
  after(() => { clock.now = () => new Date(); cleanup(f); });

  it('wrong passwords are rejected and the account is throttled after repeated failures', async () => {
    for (let i = 0; i < THROTTLE.maxPerAccount; i++) assert.equal((await login(f.db, f.cfg, 'manager@a.test', 'wrong-password', '10.0.0.5')).ok, false);
    const r = await login(f.db, f.cfg, 'manager@a.test', PASSWORD, '10.0.0.5');
    assert.deepEqual(r, { ok: false, reason: 'throttled' }); // even the right password is refused while locked
    clock.now = () => new Date(Date.now() + (THROTTLE.windowMinutes + 1) * 60_000);
    assert.equal((await login(f.db, f.cfg, 'manager@a.test', PASSWORD, '10.0.0.5')).ok, true);
    clock.now = () => new Date();
  });

  it('unknown accounts get the same answer as wrong passwords', async () => {
    assert.deepEqual(await login(f.db, f.cfg, 'nobody@a.test', 'whatever-123', '10.0.0.6'), { ok: false, reason: 'invalid' });
  });

  it('POST without the CSRF token is refused; foreign Origin is refused', async () => {
    const app = await httpApp(f);
    const br = new Browser(app);
    await br.login('reception@a.test');
    assert.equal((await br.post('/patients/new', { first_name: 'X', last_name: 'Y', date_of_birth: '2000-01-01' })).statusCode, 403);
    const csrf = await br.csrf();
    assert.equal((await br.post('/patients/new', { _csrf: csrf, first_name: 'X', last_name: 'Y', date_of_birth: '2000-01-01' }, { origin: 'https://evil.example' })).statusCode, 403);
    const ok = await br.post('/patients/new', { _csrf: csrf, first_name: 'Csrf', last_name: 'Checked', date_of_birth: '2000-01-01' });
    assert.equal(ok.statusCode, 302);
    await app.close();
  });

  it('deactivating a staff member ends their sessions immediately (works offline, locally)', async () => {
    const app = await httpApp(f);
    const br = new Browser(app);
    await br.login('reception2@a.test');
    assert.equal((await br.get('/patients')).statusCode, 200);
    deactivateMembership(f.ctx('managerA'), f.staff.reception2A.membershipId);
    const res = await br.get('/patients');
    assert.equal(res.statusCode, 302);
    assert.match(String(res.headers.location), /^\/login/);
    assert.equal((await login(f.db, f.cfg, 'reception2@a.test', PASSWORD, '10.0.0.7')).ok, false);
    await app.close();
  });

  it('idle sessions expire', async () => {
    const app = await httpApp(f);
    const br = new Browser(app);
    await br.login('dentist@a.test');
    assert.equal((await br.get('/patients')).statusCode, 200);
    clock.now = () => new Date(Date.now() + (f.cfg.sessionIdleMinutes + 1) * 60_000);
    assert.equal((await br.get('/patients')).statusCode, 302);
    clock.now = () => new Date();
    await app.close();
  });

  it('sensitive search terms are not written to request logs', async () => {
    const lines: string[] = [];
    const { buildApp } = await import('../src/web/app.js');
    const app = await buildApp({ db: f.db, cfg: f.cfg });
    app.log.info = ((orig) => function (this: unknown, ...args: unknown[]) { lines.push(JSON.stringify(args)); return (orig as (...a: unknown[]) => void).apply(this, args); })(app.log.info);
    const res = await app.inject({ method: 'GET', url: '/patients?q=SecretSurname' });
    assert.equal(res.statusCode, 302);
    await app.close();
    assert.ok(!lines.join('\n').includes('SecretSurname'));
  });
});

describe('persistence, versions, backup and restore', () => {
  let f: Fixture;
  before(async () => {
    f = await fixture();
    generateKeyFile(f.cfg.backupKeyFile);
  });
  after(() => cleanup(f));

  it('committed work survives closing and reopening the database (server restart)', () => {
    const r = f.ctx('receptionA');
    const inv = createDraftInvoice(r, { patient_id: f.patientA.id });
    addLine(r, inv, { service_id: f.svcA, quantity: '2' });
    issueInvoice(r, inv);
    recordPayment(r, inv, { payment_id: newId(), amount: '250', method: 'cash' });
    f.db.close();
    f.db = openDatabase(f.cfg.dbFile);
    const m = f.staff.receptionA;
    const again = buildContext(f.db, m.userId, m.membershipId, f.a1.id)!;
    assert.equal(getInvoice(again, inv).balance_minor, 75000);
  });

  it('a database written by a newer app version is refused, not modified', () => {
    const dir = tempDir();
    const file = path.join(dir, 'x.db');
    openDatabase(file).close();
    const raw = new Database(file);
    raw.prepare(`INSERT INTO schema_migrations (name, applied_at) VALUES ('999_future.sql', 'x')`).run();
    raw.close();
    assert.throws(() => openDatabase(file), SchemaTooNewError);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('backup restores records and attachments into a clean directory, verified', async () => {
    fs.mkdirSync(path.join(f.cfg.attachmentsDir, 'p1'), { recursive: true });
    const attachment = Buffer.from('synthetic attachment ' + 'x'.repeat(3 * 1024 * 1024)); // spans several encrypted chunks
    fs.writeFileSync(path.join(f.cfg.attachmentsDir, 'p1', 'scan.pdf'), attachment);
    const result = await runBackup(f.db, f.cfg, 'manual', null);
    assert.equal(result.verified, true);
    assert.ok(!fs.readFileSync(result.file).includes(Buffer.from('Alpha')), 'archive must not contain plaintext');

    const target = path.join(tempDir(), 'restored');
    const report = restoreBackup(result.file, f.cfg.backupKeyFile, target);
    assert.equal(report.integrity, 'ok');
    assert.deepEqual(fs.readFileSync(path.join(target, 'attachments', 'p1', 'scan.pdf')), attachment);
    const live = f.db.prepare('SELECT COUNT(*) FROM payments').pluck().get();
    assert.equal(report.counts.payments, live);

    // The restored data directory is a working server database.
    const db2 = openDatabase(path.join(target, 'branch.db'));
    assert.equal(db2.prepare('SELECT COUNT(*) FROM patients').pluck().get(), f.db.prepare('SELECT COUNT(*) FROM patients').pluck().get());
    db2.close();

    // Never overwrite: a non-empty target is refused.
    assert.throws(() => restoreBackup(result.file, f.cfg.backupKeyFile, target), BackupError);
  });

  it('tampered, truncated or wrong-key archives fail safely', async () => {
    const { file } = await runBackup(f.db, f.cfg, 'manual', null);
    const bytes = fs.readFileSync(file);
    const dir = tempDir();
    const tampered = path.join(dir, 't.dcmbak');
    const flipped = Buffer.from(bytes);
    flipped[200] = flipped[200]! ^ 1;
    fs.writeFileSync(tampered, flipped);
    assert.throws(() => restoreBackup(tampered, f.cfg.backupKeyFile, path.join(dir, 'r1')), /authentication/);
    const truncated = path.join(dir, 'tr.dcmbak');
    fs.writeFileSync(truncated, bytes.subarray(0, bytes.length - 100));
    assert.throws(() => restoreBackup(truncated, f.cfg.backupKeyFile, path.join(dir, 'r2')), BackupError);
    const otherKey = path.join(dir, 'other.key');
    generateKeyFile(otherKey);
    assert.throws(() => restoreBackup(file, otherKey, path.join(dir, 'r3')), /authentication/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('retention keeps only the newest verified backups', async () => {
    const cfg = { ...f.cfg, backupRetention: 2 };
    for (let i = 0; i < 3; i++) await runBackup(f.db, cfg, 'manual', null);
    applyRetention(f.db, cfg);
    assert.equal(fs.readdirSync(cfg.backupDir).filter((x) => x.endsWith('.dcmbak')).length, 2);
  });
});
