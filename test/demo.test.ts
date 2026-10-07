import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DateTime } from 'luxon';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/db.js';
import { demoResetDue, ensureDemoData, isDemoDatabase, wipeDemoData } from '../src/demo.js';
import { cleanup, fixture, tempDir, type Fixture } from './helpers.js';

describe('hosted demo mode', () => {
  let f: Fixture;
  before(async () => { f = await fixture(); });
  after(() => cleanup(f));

  it('seeds once, resets only after the daily time, and wipes only a demo database', async () => {
    const dir = tempDir();
    const cfg = loadConfig({ DATA_DIR: dir, DEMO_MODE: 'true', DEMO_RESET_DAILY_AT: '03:00', BACKUP_DAILY_AT: '' });
    let db = openDatabase(cfg.dbFile);
    await assert.rejects(ensureDemoData(db, cfg, undefined), /DEMO_PASSWORD/);
    assert.equal(await ensureDemoData(db, cfg, 'demo-password-xyz'), true);
    assert.equal(await ensureDemoData(db, cfg, 'demo-password-xyz'), false); // never twice
    assert.ok(isDemoDatabase(db));

    const created = DateTime.fromISO(db.prepare('SELECT created_at FROM node_identity').pluck().get() as string);
    assert.equal(demoResetDue(db, cfg, created.plus({ minutes: 1 })), false);
    assert.equal(demoResetDue(db, cfg, created.plus({ days: 1, hours: 1 })), true);

    wipeDemoData(db, cfg);
    assert.equal(fs.existsSync(cfg.dbFile), false);
    db = openDatabase(cfg.dbFile);
    assert.equal(await ensureDemoData(db, cfg, 'demo-password-xyz'), true); // reseeds after restart
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to reset or wipe a non-demo database even with demo mode on', () => {
    const cfg = { ...f.cfg, demoMode: true, demoResetDailyAt: '03:00' };
    assert.equal(isDemoDatabase(f.db), false);
    assert.equal(demoResetDue(f.db, cfg, DateTime.now().plus({ days: 2 })), false);
    assert.throws(() => wipeDemoData(f.db, cfg), /Refusing to wipe/);
    assert.ok(f.db.open);
  });

  it('demo mode is off unless explicitly enabled', () => {
    const cfg = loadConfig({ DEMO_RESET_DAILY_AT: '03:00' });
    assert.equal(cfg.demoMode, false);
    assert.equal(cfg.demoResetDailyAt, null);
  });
});
