// Milestone 2 simulation: a real cloud service (PostgreSQL via PGlite, real HTTP) and two branch servers.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { openDatabase, type DB } from '../src/db/db.js';
import { buildContext, type Ctx } from '../src/domain/context.js';
import { addDentistBlock, assignStaffToBranch, createBranch, createOperatory, createOrganization, createService, createStaff, deactivateMembership } from '../src/domain/orgs.js';
import { getPatient, registerPatient, updatePatient } from '../src/domain/patients.js';
import { bookAppointment } from '../src/domain/appointments.js';
import { addLine, createDraftInvoice, issueInvoice, recordPayment, reversePayment } from '../src/domain/billing.js';
import { newId } from '../src/lib/core.js';
import { buildCloudApp } from '../src/cloud/app.js';
import { pgliteSql, type Sql } from '../src/cloud/sql.js';
import { createInvite, migrateCloud, revokeNode } from '../src/cloud/store.js';
import { connectToCloud, getState, syncOnce, CloudHttpError } from '../src/sync/worker.js';
import { PASSWORD, tempDir } from './helpers.js';

const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, open: 8 * 60, close: 20 * 60 }));
const offline: typeof fetch = async () => { throw new TypeError('fetch failed'); };
const count = (db: DB, sql: string, ...p: unknown[]) => db.prepare(sql).pluck().get(...p) as number;

describe('multi-branch synchronization (cloud + two branches)', () => {
  let sql: Sql;
  let cloud: FastifyInstance;
  let url: string;
  let dirs: string[] = [];
  let A: DB;
  let B: DB;
  const ids: Record<string, string> = {};
  const ctxA = (who: string) => buildContext(A, ids[`${who}User`]!, ids[`${who}M`]!, ids.branchA!)!;
  const ctxB = (who: string) => buildContext(B, ids[`${who}User`]!, ids[`${who}M`]!, ids.branchB!)!;

  before(async () => {
    sql = await pgliteSql();
    await migrateCloud(sql);
    cloud = await buildCloudApp(sql, { logger: false });
    await cloud.listen({ host: '127.0.0.1', port: 0 });
    const addr = cloud.server.address() as { port: number };
    url = `http://127.0.0.1:${addr.port}`;

    // Branch A: an existing single-branch clinic (Milestone 1 data) that connects to the cloud.
    const dirA = tempDir();
    dirs.push(dirA);
    A = openDatabase(loadConfig({ DATA_DIR: dirA }).dbFile);
    const org = createOrganization(A, { name: 'Sync Test Dental' });
    ids.org = org.id;
    const a = createBranch(A, org.id, { code: 'AAA', name: 'Alpha Branch', hours: ALL_WEEK });
    ids.branchA = a.id;
    ids.chairA = createOperatory(A, org.id, a.id, 'Chair A1');
    ids.svc = createService(A, org.id, { code: 'CONS', name: 'Consultation', durationMin: 30, priceMinor: 50000 });
    for (const [k, role] of [['owner', 'owner'], ['manager', 'branch_manager'], ['dentist', 'dentist'], ['rec', 'receptionist']] as const) {
      const s = await createStaff(A, { orgId: org.id, email: `${k}@sync.test`, displayName: k, password: PASSWORD, role, branchIds: role === 'owner' ? [] : [a.id] });
      ids[`${k}User`] = s.userId;
      ids[`${k}M`] = s.membershipId;
    }
    for (let wd = 1; wd <= 7; wd++) addDentistBlock(A, org.id, a.id, ids.dentistM!, wd, 8 * 60, 20 * 60);
    const p = registerPatient(ctxA('rec'), { first_name: 'Shared', last_name: 'Patient', date_of_birth: '1985-05-05', phone: '0917 300 0001' });
    ids.patient = p.id;
    const appt = bookAppointment(ctxA('rec'), { patient_id: p.id, dentist_id: ids.dentistM, operatory_id: ids.chairA, service_id: ids.svc, date: '2030-01-07', time: '09:00', duration_min: '30' });
    const inv = createDraftInvoice(ctxA('rec'), { patient_id: p.id, appointment_id: appt.id });
    addLine(ctxA('rec'), inv, { service_id: ids.svc, quantity: '2' });
    issueInvoice(ctxA('rec'), inv);
    recordPayment(ctxA('rec'), inv, { payment_id: newId(), amount: '300', method: 'cash' });
    ids.invoiceA = inv;
  });

  after(async () => {
    A?.close();
    B?.close();
    await cloud?.close();
    await sql?.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('1. branch A connects with a one-time code and uploads its organization and history', async () => {
    const { code } = await createInvite(sql, { kind: 'new_org' });
    await connectToCloud(A, url, code);
    await assert.rejects(connectToCloud(A, url, code), /already connected/);
    const r = await syncOnce(A);
    assert.equal(r.state, 'online');
    assert.equal(r.rejected, 0, JSON.stringify(A.prepare(`SELECT entity_type, op, last_error FROM outbox_events WHERE status = 'failed'`).all()));
    assert.equal(count(A, `SELECT COUNT(*) FROM outbox_events WHERE status <> 'acked'`), 0);
    assert.equal((await sql.query(`SELECT 1 FROM patients WHERE id = $1`, [ids.patient])).length, 1);
    assert.equal(count(A, 'SELECT cloud_version FROM patients WHERE id = ?', ids.patient), 1); // confirmed by the cloud
  });

  it('a used or wrong code cannot enroll another server', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const X = openDatabase(path.join(dir, 'x.db'));
    await assert.rejects(connectToCloud(X, url, 'DS-AAAA-BBBB-CCCC'), (e: unknown) => e instanceof CloudHttpError && e.status === 403);
    X.close();
  });

  it('2. a fresh server joins as branch B and receives staff, services, patients and A’s records', async () => {
    const { code, branchId } = await createInvite(sql, { kind: 'join_branch', orgId: ids.org!, branchCode: 'BBB', branchName: 'Bravo Branch' });
    const dirB = tempDir();
    dirs.push(dirB);
    B = openDatabase(path.join(dirB, 'branch.db'));
    const res = await connectToCloud(B, url, code);
    assert.equal(res.branch_id, branchId);
    ids.branchB = branchId!;
    const r = await syncOnce(B);
    assert.equal(r.state, 'online', r.error);
    assert.equal(count(B, 'SELECT COUNT(*) FROM users'), 4);
    assert.equal(count(B, 'SELECT COUNT(*) FROM services'), 1);
    assert.equal(count(B, 'SELECT COUNT(*) FROM patients WHERE id = ?', ids.patient), 1);
    assert.equal(count(B, 'SELECT COUNT(*) FROM invoices WHERE id = ? AND status = ?', ids.invoiceA, 'issued'), 1);
    assert.equal(count(B, 'SELECT COUNT(*) FROM payments'), 1);
    // The owner can sign in at B offline: credentials were replicated.
    assert.ok(ctxB('owner'));
    // Set up branch B locally (chair, staff assignment, dentist hours); these sync back to A.
    const orgId = ids.org!;
    ids.chairB = createOperatory(B, orgId, ids.branchB, 'Chair B1');
    assignStaffToBranch(B, ids.recM!, ids.branchB);
    assignStaffToBranch(B, ids.dentistM!, ids.branchB);
    for (let wd = 1; wd <= 7; wd++) addDentistBlock(B, orgId, ids.branchB, ids.dentistM!, wd, 8 * 60, 20 * 60);
    B.prepare('DELETE FROM branch_hours WHERE branch_id = ?').run(ids.branchB);
    for (const h of ALL_WEEK) B.prepare('INSERT INTO branch_hours VALUES (?, ?, ?, ?)').run(ids.branchB, h.weekday, h.open, h.close);
    assert.equal((await syncOnce(B)).state, 'online');
    assert.equal((await syncOnce(A)).state, 'online');
    assert.equal(count(A, 'SELECT COUNT(*) FROM operatories WHERE id = ?', ids.chairB), 1);
    assert.equal(count(A, 'SELECT COUNT(*) FROM membership_branches WHERE membership_id = ? AND branch_id = ?', ids.recM, ids.branchB), 1);
  });

  it('3–5. branch A loses internet, both keep working, A reconnects, everything reconciles', async () => {
    // A offline: syncing fails as "offline", local work continues.
    const off = await syncOnce(A, { fetchImpl: offline });
    assert.equal(off.state, 'offline');
    assert.ok(getState(A).offline_since);

    // A: new patient, appointment and payment while offline.
    const pA = registerPatient(ctxA('rec'), { first_name: 'Offline', last_name: 'Alpha', date_of_birth: '1999-09-09' });
    const inv = createDraftInvoice(ctxA('rec'), { patient_id: pA.id });
    addLine(ctxA('rec'), inv, { service_id: ids.svc, quantity: '1' });
    issueInvoice(ctxA('rec'), inv);
    const pay = recordPayment(ctxA('rec'), inv, { payment_id: newId(), amount: '200', method: 'cash' });
    reversePayment(ctxA('manager'), pay.paymentId, 'entered twice by mistake');
    assert.equal((await syncOnce(A, { fetchImpl: offline })).state, 'offline');
    assert.ok(count(A, `SELECT COUNT(*) FROM outbox_events WHERE status = 'pending'`) >= 4);

    // B (online) works too: books the shared patient and edits their phone.
    bookAppointment(ctxB('rec'), { patient_id: ids.patient, dentist_id: ids.dentistM, operatory_id: ids.chairB, service_id: ids.svc, date: '2030-01-08', time: '10:00', duration_min: '30' });
    const pB = getPatient(ctxB('rec'), ids.patient!);
    updatePatient(ctxB('rec'), ids.patient!, { ...pB, phone: '0917 999 0000' }, pB.version);
    assert.equal((await syncOnce(B)).state, 'online');

    // A, still offline, edits the SAME phone differently and a DIFFERENT field (address).
    const pa = getPatient(ctxA('rec'), ids.patient!);
    updatePatient(ctxA('rec'), ids.patient!, { ...pa, phone: '0917 111 2222', address: '9 New Street' }, pa.version);

    // Reconnect.
    const back = await syncOnce(A);
    assert.equal(back.state, 'online', back.error);
    assert.equal(getState(A).offline_since, undefined);
    assert.equal((await syncOnce(B)).state, 'online');

    // Non-conflicting field merged everywhere; conflicting field keeps B's earlier value and is surfaced.
    for (const db of [A, B]) {
      const row = db.prepare('SELECT phone, address FROM patients WHERE id = ?').get(ids.patient) as { phone: string; address: string };
      assert.equal(row.address, '9 New Street');
      assert.equal(row.phone, '0917 999 0000');
      const c = db.prepare(`SELECT field, kept_value, incoming_value FROM sync_conflicts WHERE entity_id = ? AND status = 'open'`).all(ids.patient) as { field: string; kept_value: string; incoming_value: string }[];
      assert.deepEqual(c, [{ field: 'phone', kept_value: '0917 999 0000', incoming_value: '0917 111 2222' }]);
    }
    // A's offline financial work reached B exactly once, with the reversal.
    assert.equal(count(B, 'SELECT COUNT(*) FROM payments WHERE id = ?', pay.paymentId), 1);
    assert.equal(count(B, 'SELECT COUNT(*) FROM payment_reversals WHERE payment_id = ?', pay.paymentId), 1);
    assert.equal(count(B, 'SELECT COUNT(*) FROM patients WHERE id = ?', pA.id), 1);
  });

  it('retried uploads (lost acknowledgement) never duplicate patients, invoices or payments', async () => {
    const p = registerPatient(ctxA('rec'), { first_name: 'Retry', last_name: 'Case', date_of_birth: '2001-01-01' });
    const inv = createDraftInvoice(ctxA('rec'), { patient_id: p.id });
    addLine(ctxA('rec'), inv, { service_id: ids.svc, quantity: '1' });
    issueInvoice(ctxA('rec'), inv);
    const pay = recordPayment(ctxA('rec'), inv, { payment_id: newId(), amount: '100', method: 'cash' });
    // Deliver, but lose the response: the cloud has the events, A doesn't know.
    const lose: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (String(input).includes('/events')) {
        await res.arrayBuffer(); // the cloud fully processed the batch…
        throw new TypeError('connection reset after send'); // …but the reply never arrives
      }
      return res;
    };
    assert.equal((await syncOnce(A, { fetchImpl: lose })).state, 'offline');
    assert.equal(count(A, `SELECT COUNT(*) FROM outbox_events WHERE status = 'pending'`), 3); // patient, invoice, payment
    const r = await syncOnce(A); // resend: all reported as duplicates and acknowledged
    assert.equal(r.state, 'online');
    assert.equal(r.rejected, 0);
    assert.equal(count(A, `SELECT COUNT(*) FROM outbox_events WHERE status <> 'acked'`), 0);
    assert.equal((await sql.query('SELECT 1 FROM patients WHERE id = $1', [p.id])).length, 1);
    assert.equal((await sql.query(`SELECT 1 FROM changes WHERE entity_id = $1 AND kind = 'branch.fact'`, [pay.paymentId])).length, 1);
    await syncOnce(B);
    await syncOnce(B); // and re-downloading is harmless
    assert.equal(count(B, 'SELECT COUNT(*) FROM payments WHERE id = ?', pay.paymentId), 1);
    assert.equal(count(B, 'SELECT COUNT(*) FROM invoices WHERE id = ?', inv), 1);
  });

  it('an interrupted download is rolled back and resumes cleanly', async () => {
    registerPatient(ctxA('rec'), { first_name: 'Interrupted', last_name: 'One', date_of_birth: '2002-02-02' });
    registerPatient(ctxA('rec'), { first_name: 'Interrupted', last_name: 'Two', date_of_birth: '2002-02-03' });
    await syncOnce(A);
    const cursorBefore = getState(B).download_cursor;
    const crash = await syncOnce(B, { failAfterApplying: 1 });
    assert.equal(crash.state, 'error');
    assert.equal(getState(B).download_cursor, cursorBefore);
    assert.equal(count(B, `SELECT COUNT(*) FROM patients WHERE first_name = 'Interrupted'`), 0); // nothing half-applied
    assert.equal((await syncOnce(B)).state, 'online');
    assert.equal(count(B, `SELECT COUNT(*) FROM patients WHERE first_name = 'Interrupted'`), 2);
  });

  it('6. cloud unavailable: both branches keep working and catch up afterwards', async () => {
    const port = (cloud.server.address() as { port: number }).port;
    await cloud.close();
    const rec = registerPatient(ctxB('rec'), { first_name: 'Cloud', last_name: 'Down', date_of_birth: '1990-10-10' });
    assert.equal((await syncOnce(B)).state, 'offline');
    assert.equal((await syncOnce(A)).state, 'offline');
    cloud = await buildCloudApp(sql, { logger: false });
    await cloud.listen({ host: '127.0.0.1', port });
    assert.equal((await syncOnce(B)).state, 'online');
    assert.equal((await syncOnce(A)).state, 'online');
    assert.equal(count(A, 'SELECT COUNT(*) FROM patients WHERE id = ?', rec.id), 1);
  });

  it('revocations travel: a deactivation at B ends the user’s sessions at A after sync', async () => {
    const m = ids.managerM!;
    assignStaffToBranch(A, m, ids.branchB!);
    await syncOnce(A);
    await syncOnce(B);
    A.prepare(`INSERT INTO sessions (token_hash, user_id, membership_id, branch_id, csrf_token, session_version, created_at, last_seen_at, expires_at)
               VALUES ('h1', ?, ?, ?, 'c', 1, '2030-01-01', '2030-01-01', '2030-01-02')`).run(ids.recUser, ids.recM, ids.branchA);
    deactivateMembership(ctxB('manager'), ids.recM!);
    await syncOnce(B);
    await syncOnce(A);
    assert.equal(count(A, 'SELECT is_active FROM memberships WHERE id = ?', ids.recM), 0);
    assert.equal(count(A, 'SELECT COUNT(*) FROM sessions WHERE user_id = ?', ids.recUser), 0);
    assert.equal(buildContext(A, ids.recUser!, ids.recM!, ids.branchA!), null);
  });

  it('ownership: a branch cannot change another branch’s records through the cloud', async () => {
    const st = getState(B);
    const nodeB = B.prepare('SELECT id FROM node_identity').pluck().get() as string;
    const forged = { id: newId(), org_id: st.org_id, branch_id: st.branch_id, node_id: nodeB, seq: 999999, entity_type: 'invoice', entity_id: ids.invoiceA,
      op: 'voided', entity_version: 2, base_version: 1, actor_user_id: null, payload: { reason: 'forged', voided_at: new Date().toISOString() }, schema_version: 1, app_version: 'x', created_at: new Date().toISOString() };
    const res = await fetch(`${url}/sync/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dentalsys-protocol': '1', authorization: `Bearer ${nodeB}.${st.node_secret}` }, body: JSON.stringify({ events: [forged] }) });
    const body = await res.json() as { results: { status: string; reason?: string }[] };
    assert.equal(body.results[0]!.status, 'rejected');
    assert.match(body.results[0]!.reason!, /owned by another branch/);
  });

  it('tenant isolation: another organization’s server can neither read nor write this organization', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const C = openDatabase(path.join(dir, 'c.db'));
    const orgC = createOrganization(C, { name: 'Other Clinic' });
    createBranch(C, orgC.id, { code: 'CCC', name: 'Other' });
    await connectToCloud(C, url, (await createInvite(sql, { kind: 'new_org' })).code);
    await syncOnce(C);
    assert.equal(count(C, 'SELECT COUNT(*) FROM patients'), 0);
    assert.equal(count(C, 'SELECT COUNT(*) FROM organizations'), 1);
    // Forge an event claiming org A.
    const st = getState(C);
    const nodeC = C.prepare('SELECT id FROM node_identity').pluck().get() as string;
    const forged = { id: newId(), org_id: ids.org, branch_id: ids.branchA, node_id: nodeC, seq: 1, entity_type: 'patient', entity_id: ids.patient, op: 'updated',
      entity_version: 9, base_version: 8, actor_user_id: null, payload: { changes: { phone: 'hijack' }, base_cloud_version: 99 }, schema_version: 1, app_version: 'x', created_at: new Date().toISOString() };
    const res = await fetch(`${url}/sync/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dentalsys-protocol': '1', authorization: `Bearer ${nodeC}.${st.node_secret}` }, body: JSON.stringify({ events: [forged] }) });
    assert.equal(((await res.json()) as { results: { status: string }[] }).results[0]!.status, 'rejected');
    // Even with its own org id, it cannot touch org A's patient.
    const forged2 = { ...forged, id: newId(), org_id: st.org_id, branch_id: st.branch_id };
    const res2 = await fetch(`${url}/sync/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dentalsys-protocol': '1', authorization: `Bearer ${nodeC}.${st.node_secret}` }, body: JSON.stringify({ events: [forged2] }) });
    assert.equal(((await res2.json()) as { results: { status: string }[] }).results[0]!.status, 'rejected');
    assert.notEqual((await sql.query<{ fields: { phone: string } }>('SELECT fields FROM patients WHERE id = $1', [ids.patient]))[0]!.fields.phone, 'hijack');
    C.close();
  });

  it('unsupported protocol versions and revoked servers fail safely without losing queued work', async () => {
    registerPatient(ctxA('owner'), { first_name: 'Queued', last_name: 'Safely', date_of_birth: '1977-07-07' });
    const r = await syncOnce(A, { protocolVersion: 99 });
    assert.equal(r.state, 'update_required');
    assert.ok(count(A, `SELECT COUNT(*) FROM outbox_events WHERE status = 'pending'`) >= 1);
    assert.equal((await syncOnce(A)).state, 'online');

    await revokeNode(sql, B.prepare('SELECT id FROM node_identity').pluck().get() as string);
    registerPatient(ctxB('owner'), { first_name: 'After', last_name: 'Revoke', date_of_birth: '1980-08-08' });
    assert.equal((await syncOnce(B)).state, 'revoked');
    assert.equal(count(B, `SELECT COUNT(*) FROM outbox_events WHERE status = 'pending'`), 1); // kept locally
  });
});
