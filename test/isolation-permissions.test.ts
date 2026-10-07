import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Browser, booking, cleanup, fixture, httpApp, type Fixture } from './helpers.js';
import { getPatient, searchPatients, updatePatient } from '../src/domain/patients.js';
import { bookAppointment } from '../src/domain/appointments.js';
import { createDraftInvoice, getInvoice, recordPayment, reversePayment, addLine, issueInvoice } from '../src/domain/billing.js';
import { dailyCollections } from '../src/domain/reports.js';
import { AppError, newId } from '../src/lib/core.js';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '../src/auth/permissions.js';
import { buildContext } from '../src/domain/context.js';

const status = (fn: () => unknown) => {
  try { fn(); return 200; } catch (e) { if (e instanceof AppError) return e.status; throw e; }
};

describe('tenant isolation', () => {
  let f: Fixture;
  before(async () => { f = await fixture(); });
  after(() => cleanup(f));

  it('Org B cannot read, search, book or bill Org A patients (domain layer)', () => {
    const b = f.ctx('receptionB');
    assert.equal(status(() => getPatient(b, f.patientA.id)), 404);
    assert.equal(searchPatients(b, 'Alpha').length, 0);
    assert.equal(searchPatients(b, f.patientA.patient_no).length, 0);
    assert.equal(status(() => updatePatient(b, f.patientA.id, { first_name: 'X', last_name: 'Y', date_of_birth: '1990-01-01' }, 1)), 404);
    assert.equal(status(() => bookAppointment(b, booking(f, { dentist_id: f.staff.dentistB.membershipId, operatory_id: f.chairB }))), 404);
    assert.equal(status(() => createDraftInvoice(b, { patient_id: f.patientA.id })), 404);
  });

  it('Org B cannot use Org A dentist/chair IDs by changing request fields', () => {
    const b = f.ctx('receptionB');
    assert.equal(status(() => bookAppointment(b, booking(f, { patient_id: f.patientB.id, dentist_id: f.staff.dentistA.membershipId, operatory_id: f.chairB }))), 422);
    assert.equal(status(() => bookAppointment(b, booking(f, { patient_id: f.patientB.id, dentist_id: f.staff.dentistB.membershipId, operatory_id: f.chairA1 }))), 422);
  });

  it('Org B cannot see or pay Org A invoices', () => {
    const a = f.ctx('receptionA');
    const inv = createDraftInvoice(a, { patient_id: f.patientA.id });
    addLine(a, inv, { service_id: f.svcA, quantity: '1' });
    issueInvoice(a, inv);
    const pid = newId();
    recordPayment(a, inv, { payment_id: pid, amount: '100', method: 'cash' });
    const b = f.ctx('receptionB');
    assert.equal(status(() => getInvoice(b, inv)), 404);
    assert.equal(status(() => recordPayment(b, inv, { payment_id: newId(), amount: '1', method: 'cash' })), 404);
    // Re-submitting Org A's payment ID from Org B must not leak or duplicate.
    assert.equal(status(() => recordPayment(b, inv, { payment_id: pid, amount: '100', method: 'cash' })), 409);
    assert.equal(dailyCollections(b, new Date().toISOString().slice(0, 10)).payments.length, 0);
  });

  it('a context cannot be built for a branch of another organization or an unassigned branch', () => {
    const m = f.staff.receptionB;
    assert.equal(buildContext(f.db, m.userId, m.membershipId, f.a1.id), null);
    const r = f.staff.receptionA;
    assert.equal(buildContext(f.db, r.userId, r.membershipId, f.a2.id), null); // same org, not assigned
    const o = f.staff.ownerA;
    assert.ok(buildContext(f.db, o.userId, o.membershipId, f.a2.id)); // owners: all branches of their org
    assert.equal(buildContext(f.db, o.userId, o.membershipId, f.b1.id), null);
  });

  it('HTTP: changing IDs in URLs or forms does not cross organizations', async () => {
    const app = await httpApp(f);
    const br = new Browser(app);
    assert.equal((await br.login('reception@b.test')).statusCode, 302);
    assert.equal((await br.get(`/patients/${f.patientA.id}`)).statusCode, 404);
    assert.equal((await br.get(`/patients/${f.patientA.id}/edit`)).statusCode, 404);
    const csrf = await br.csrf();
    // try to switch into Org A's branch
    assert.equal((await br.post('/switch-branch', { _csrf: csrf, branch_id: f.a1.id })).statusCode, 403);
    // try to create an invoice for Org A's patient
    assert.equal((await br.post('/invoices/new', { _csrf: csrf, patient_id: f.patientA.id })).statusCode, 404);
    const search = await br.get('/patients?q=Alpha');
    assert.ok(!search.body.includes(f.patientA.patient_no));
    assert.ok(search.body.includes('No patients match'));
    await app.close();
  });

  it('cross-branch: a receptionist assigned only to branch A2 cannot open an A1-only patient', () => {
    const r2 = f.ctx('receptionA2only');
    assert.equal(status(() => getPatient(r2, f.patientA.id)), 404);
    // ...but can find them in minimal search results to avoid creating a duplicate
    assert.equal(searchPatients(r2, 'Alpha').length, 1);
  });
});

describe('permissions', () => {
  let f: Fixture;
  before(async () => { f = await fixture(); });
  after(() => cleanup(f));

  it('receptionist cannot see medical details; sees only that alerts exist', () => {
    const d = f.ctx('dentistA');
    updatePatient(d, f.patientA.id, { first_name: 'Test', last_name: 'Alpha', date_of_birth: '1990-01-01', phone: '0917 111 0001', allergies: 'Latex' }, f.patientA.version);
    const viaReception = getPatient(f.ctx('receptionA'), f.patientA.id);
    assert.equal(viaReception.allergies, '');
    assert.equal(viaReception.has_medical_alerts, true);
    assert.equal(getPatient(d, f.patientA.id).allergies, 'Latex');
  });

  it('receptionist edits cannot wipe medical data they cannot see', () => {
    const p = getPatient(f.ctx('dentistA'), f.patientA.id);
    updatePatient(f.ctx('receptionA'), f.patientA.id, { first_name: 'Test', last_name: 'Alpha', date_of_birth: '1990-01-01', phone: '0917 111 9999', allergies: '' }, p.version);
    assert.equal(getPatient(f.ctx('dentistA'), f.patientA.id).allergies, 'Latex');
  });

  it('inventory staff have no patient, scheduling or billing access', () => {
    const inv = f.ctx('inventoryA');
    assert.equal(status(() => searchPatients(inv, 'Alpha')), 403);
    assert.equal(status(() => getPatient(inv, f.patientA.id)), 403);
    assert.equal(status(() => bookAppointment(inv, booking(f))), 403);
  });

  it('financial and clinical permissions are separate', () => {
    const d = f.ctx('dentistA');
    const inv = createDraftInvoice(d, { patient_id: f.patientA.id }); // dentist may draft
    addLine(d, inv, { service_id: f.svcA, quantity: '1' });
    assert.equal(status(() => issueInvoice(d, inv)), 403); // but not issue
    issueInvoice(f.ctx('receptionA'), inv);
    assert.equal(status(() => recordPayment(d, inv, { payment_id: newId(), amount: '1', method: 'cash' })), 403);
    const r = recordPayment(f.ctx('receptionA'), inv, { payment_id: newId(), amount: '1', method: 'cash' });
    assert.equal(status(() => reversePayment(f.ctx('receptionA'), r.paymentId, 'wrong amount')), 403);
    assert.equal(status(() => reversePayment(f.ctx('managerA'), r.paymentId, 'wrong amount')), 200);
    assert.equal(status(() => dailyCollections(d, '2030-01-07')), 403);
  });

  it('docs/04-permissions.md matches the code', () => {
    const md = fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', '04-permissions.md'), 'utf8');
    const rows = md.split('\n').filter((l) => l.startsWith('| `'));
    const documented = new Set<string>();
    for (const row of rows) {
      const cells = row.split('|').slice(1, -1).map((c) => c.trim());
      const perms = [...cells[0]!.matchAll(/`([a-z_.]+)`/g)].map((m) => m[1]!);
      for (const perm of perms) {
        documented.add(perm);
        ROLES.forEach((role, i) => {
          const marked = cells[i + 1] === '✓';
          assert.equal(marked, ROLE_PERMISSIONS[role].includes(perm as never), `${perm} / ${role}`);
        });
      }
    }
    assert.deepEqual([...documented].sort(), [...PERMISSIONS].sort());
  });
});
