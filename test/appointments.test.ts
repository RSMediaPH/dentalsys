import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { booking, cleanup, fixture, MONDAY, type Fixture } from './helpers.js';
import { appointmentHistory, bookAppointment, changeStatus, getAppointment, rescheduleAppointment } from '../src/domain/appointments.js';
import { AppError, newId, nowIso } from '../src/lib/core.js';

const code = (fn: () => unknown) => {
  try { fn(); return 'ok'; } catch (e) { if (e instanceof AppError) return e.code; throw e; }
};

describe('appointments', () => {
  let f: Fixture;
  before(async () => { f = await fixture(); });
  after(() => cleanup(f));

  it('prevents overlaps for the same chair and the same dentist; allows adjacent slots', () => {
    const r = f.ctx('receptionA');
    bookAppointment(r, booking(f, { time: '09:00', duration_min: '30' }));
    // same chair, different dentist, overlapping
    assert.equal(code(() => bookAppointment(r, booking(f, { time: '09:15', dentist_id: f.staff.dentistA2.membershipId }))), 'APPOINTMENT_OVERLAP');
    // same dentist, different chair, overlapping
    assert.equal(code(() => bookAppointment(r, booking(f, { time: '09:29', operatory_id: f.chairA2 }))), 'APPOINTMENT_OVERLAP');
    // adjacent is fine
    assert.equal(code(() => bookAppointment(r, booking(f, { time: '09:30' }))), 'ok');
    // different dentist + different chair at the same time is fine
    assert.equal(code(() => bookAppointment(r, booking(f, { time: '09:00', dentist_id: f.staff.dentistA2.membershipId, operatory_id: f.chairA2 }))), 'ok');
  });

  it('enforces branch hours and dentist working blocks', () => {
    const r = f.ctx('receptionA');
    assert.equal(code(() => bookAppointment(r, booking(f, { time: '07:30' }))), 'VALIDATION'); // before opening
    assert.equal(code(() => bookAppointment(r, booking(f, { time: '19:45' }))), 'VALIDATION'); // runs past close
    assert.equal(code(() => bookAppointment(r, booking(f, { time: '12:00', dentist_id: f.staff.dentistA2.membershipId, operatory_id: f.chairA2 }))), 'VALIDATION'); // dentist2 works until 12:00
  });

  it('cancelling frees the slot; history records every change with reason', () => {
    const r = f.ctx('receptionA');
    const a = bookAppointment(r, booking(f, { time: '15:00' }));
    assert.equal(code(() => changeStatus(r, a.id, 'cancelled', '', a.version)), 'VALIDATION'); // reason required
    changeStatus(r, a.id, 'cancelled', 'Patient called', a.version);
    const again = bookAppointment(r, booking(f, { time: '15:00' }));
    rescheduleAppointment(r, again.id, { dentist_id: f.staff.dentistA.membershipId, operatory_id: f.chairA1, date: MONDAY, time: '16:00', duration_min: '45', reason: 'Patient asked later' }, again.version);
    const h = appointmentHistory(r, again.id);
    assert.deepEqual(h.map((e) => e.kind), ['created', 'rescheduled']);
    assert.equal(JSON.parse(h[1]!.details_json).from.start_at.slice(11, 16), '07:00'); // 15:00 Manila = 07:00 UTC
    assert.equal(h[1]!.reason, 'Patient asked later');
    assert.equal(code(() => changeStatus(r, again.id, 'completed', '', getAppointment(r, again.id).version)), 'INVALID_TRANSITION');
  });

  it('stale edits are rejected rather than silently overwriting', () => {
    const r = f.ctx('receptionA');
    const a = bookAppointment(r, booking(f, { time: '17:00' }));
    changeStatus(r, a.id, 'confirmed', '', a.version);
    assert.equal(code(() => changeStatus(f.ctx('reception2A'), a.id, 'cancelled', 'old screen', a.version)), 'STALE_EDIT');
  });

  it('database trigger blocks overlaps even if application checks are bypassed', () => {
    const insert = () => f.db.prepare(`INSERT INTO appointments (id, org_id, branch_id, patient_id, dentist_membership_id, operatory_id, start_at, end_at, status, created_at, created_by, updated_at, updated_by)
      SELECT ?, org_id, branch_id, patient_id, dentist_membership_id, operatory_id, start_at, end_at, 'scheduled', ?, created_by, ?, updated_by FROM appointments WHERE status = 'scheduled' LIMIT 1`).run(newId(), nowIso(), nowIso());
    assert.throws(insert, /APPOINTMENT_OVERLAP/);
  });

  it('two receptionists booking the same chair at the same moment: exactly one succeeds (separate DB connections)', async () => {
    const workerFile = path.join(import.meta.dirname, 'workers', 'book-worker.mjs');
    const barrier = new SharedArrayBuffer(4);
    const runs = 6;
    let ok = 0;
    let overlap = 0;
    for (let i = 0; i < runs; i++) {
      new Int32Array(barrier).fill(0);
      const time = `${10 + Math.floor(i / 4)}:${String((i % 4) * 15).padStart(2, '0')}`; // 10:00..11:15, inside both dentists' hours
      const who = [f.staff.receptionA, f.staff.reception2A];
      const results = await Promise.all(who.map((m, k) => new Promise<string>((resolve, reject) => {
        const w = new Worker(workerFile, {
          workerData: { dbFile: f.cfg.dbFile, userId: m.userId, membershipId: m.membershipId, branchId: f.a1.id, barrier, parties: 2,
            input: booking(f, { time, duration_min: '15', operatory_id: f.chairA2, dentist_id: k === 0 ? f.staff.dentistA.membershipId : f.staff.dentistA2.membershipId }) },
        });
        w.once('message', resolve);
        w.once('error', reject);
      })));
      if (process.env.DEBUG_WORKERS) console.log(time, results);
      ok += results.filter((r) => r === "ok").length;
      overlap += results.filter((r) => r === 'APPOINTMENT_OVERLAP').length;
    }
    assert.equal(ok, runs);
    assert.equal(overlap, runs);
  });
});
