// Creates a synthetic demo organization. ALL names, numbers and addresses are fictitious.
// Usage: npm run seed:demo   (refuses to run if the database already has an organization)
import fs from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { loadConfig, PROJECT_ROOT } from '../config.js';
import { openDatabase, type DB } from '../db/db.js';
import { generateKeyFile } from '../backup/backup.js';
import { buildContext, type Ctx } from '../domain/context.js';
import { addDentistBlock, createBranch, createOperatory, createOrganization, createService, createStaff } from '../domain/orgs.js';
import { registerPatient } from '../domain/patients.js';
import { bookAppointment, changeStatus } from '../domain/appointments.js';
import { addLine, createDraftInvoice, issueInvoice, recordPayment } from '../domain/billing.js';
import { newId } from '../lib/core.js';

export const DEMO_DOMAIN = 'demo.test';
export const DEMO_ORG_NAME = 'Sample Dental Group (DEMO)';

export async function seedDemo(db: DB, password: string): Promise<{ ctxs: Record<string, Ctx> }> {
  if (db.prepare('SELECT 1 FROM organizations').get()) throw new Error('Database already contains an organization; refusing to seed.');
  const org = createOrganization(db, { name: DEMO_ORG_NAME });
  const branch = createBranch(db, org.id, { code: 'MKT', name: 'Demo Branch Main', address: '100 Example Avenue, Unit 2 (fictitious)', phone: '+63 2 0000 0000', email: `main@${DEMO_DOMAIN}` });
  const chairs = ['Chair 1', 'Chair 2', 'Chair 3'].map((n) => createOperatory(db, org.id, branch.id, n));

  const staff = {
    owner: await createStaff(db, { orgId: org.id, email: `owner@${DEMO_DOMAIN}`, displayName: 'Olivia Owner', password, role: 'owner', branchIds: [] }),
    manager: await createStaff(db, { orgId: org.id, email: `manager@${DEMO_DOMAIN}`, displayName: 'Marco Manager', password, role: 'branch_manager', branchIds: [branch.id] }),
    dentist1: await createStaff(db, { orgId: org.id, email: `dentist1@${DEMO_DOMAIN}`, displayName: 'Dr. Dana Reyes (demo)', password, role: 'dentist', branchIds: [branch.id] }),
    dentist2: await createStaff(db, { orgId: org.id, email: `dentist2@${DEMO_DOMAIN}`, displayName: 'Dr. Sam Cruz (demo)', password, role: 'dentist', branchIds: [branch.id] }),
    reception: await createStaff(db, { orgId: org.id, email: `reception@${DEMO_DOMAIN}`, displayName: 'Rita Reception', password, role: 'receptionist', branchIds: [branch.id] }),
    reception2: await createStaff(db, { orgId: org.id, email: `reception2@${DEMO_DOMAIN}`, displayName: 'Ray Reception', password, role: 'receptionist', branchIds: [branch.id] }),
    inventory: await createStaff(db, { orgId: org.id, email: `inventory@${DEMO_DOMAIN}`, displayName: 'Ivy Inventory', password, role: 'inventory_staff', branchIds: [branch.id] }),
  };
  for (const wd of [1, 2, 3, 4, 5, 6]) addDentistBlock(db, org.id, branch.id, staff.dentist1.membershipId, wd, 9 * 60, 18 * 60);
  for (const wd of [1, 3, 5]) addDentistBlock(db, org.id, branch.id, staff.dentist2.membershipId, wd, 9 * 60, 15 * 60);

  const services = [
    { code: 'CONS', name: 'Consultation', durationMin: 30, priceMinor: 50000 },
    { code: 'PROPH', name: 'Oral prophylaxis (cleaning)', durationMin: 45, priceMinor: 150000 },
    { code: 'FILL1', name: 'Composite filling, one surface', durationMin: 60, priceMinor: 200000 },
    { code: 'EXT', name: 'Simple extraction', durationMin: 45, priceMinor: 180000 },
    { code: 'FLUOR', name: 'Fluoride application', durationMin: 15, priceMinor: 80000 },
    { code: 'RCT-A', name: 'Root canal treatment, anterior', durationMin: 90, priceMinor: 800000 },
  ].map((s) => ({ ...s, id: createService(db, org.id, s) }));

  const ctx = (m: { userId: string; membershipId: string }) => buildContext(db, m.userId, m.membershipId, branch.id, 'seed')!;
  const rec = ctx(staff.reception);
  const dentist = ctx(staff.dentist1);

  const people: [string, string, string, string][] = [
    ['Alex', 'Santos', '1988-04-12', '0917 000 0101'], ['Bea', 'Villanueva', '1995-11-30', '0917 000 0102'],
    ['Carlo', 'Mendoza', '1979-02-05', '0917 000 0103'], ['Dina', 'Ramos', '2012-07-19', '0917 000 0104'],
    ['Eli', 'Torres', '1990-09-09', '0917 000 0105'], ['Faye', 'Garcia', '1984-01-23', '0917 000 0106'],
    ['Gabe', 'Navarro', '2001-06-14', '0917 000 0107'], ['Hana', 'Lim', '1972-12-02', '0917 000 0108'],
    ['Ivan', 'Bautista', '1999-03-27', '0917 000 0109'], ['Jo', 'Aquino', '1966-08-08', '0917 000 0110'],
  ];
  const patients = people.map(([first, last, dob, phone], i) =>
    registerPatient(i === 3 ? dentist : rec, {
      first_name: first, last_name: last, date_of_birth: dob, phone, email: `${first.toLowerCase()}.${last.toLowerCase()}@${DEMO_DOMAIN}`,
      address: `${i + 1} Sample Street (fictitious)`,
      ...(i === 3 ? { guardian_name: 'Parent Ramos (demo)', guardian_relationship: 'Mother', guardian_phone: '0917 000 0199', allergies: 'Penicillin (demo entry)' } : {}),
    }, { confirmedNotDuplicate: true }),
  );

  // Appointments on the next 6 open days starting today (branch time).
  const tz = branch.timezone;
  let day = DateTime.now().setZone(tz).startOf('day');
  let booked = 0;
  for (let d = 0; d < 8 && booked < 14; d++, day = day.plus({ days: 1 })) {
    if (day.weekday === 7) continue;
    const slots: [number, string, string, number][] = [
      [0, '09:00', staff.dentist1.membershipId, 0], [1, '10:00', staff.dentist1.membershipId, 1], [2, '13:30', staff.dentist1.membershipId, 0],
    ];
    if ([1, 3, 5].includes(day.weekday)) slots.push([3, '09:30', staff.dentist2.membershipId, 2]);
    for (const [k, time, dentistId, chair] of slots) {
      const p = patients[(d * 3 + k) % patients.length]!;
      const svc = services[(d + k) % services.length]!;
      try {
        bookAppointment(rec, { patient_id: p.id, dentist_id: dentistId, operatory_id: chairs[chair]!, service_id: svc.id, date: day.toISODate()!, time, duration_min: String(svc.durationMin) });
        booked++;
      } catch { /* slot invalid on this day; skip */ }
    }
  }

  // Two completed visits with invoices: one fully paid, one partially paid.
  const firstTwo = db.prepare(`SELECT * FROM appointments ORDER BY start_at LIMIT 2`).all() as { id: string; patient_id: string; version: number }[];
  for (const [i, a] of firstTwo.entries()) {
    changeStatus(rec, a.id, 'arrived', '', a.version);
    changeStatus(dentist, a.id, 'completed', '', a.version + 1);
    const inv = createDraftInvoice(dentist, { patient_id: a.patient_id, appointment_id: a.id });
    addLine(dentist, inv, { service_id: services[0]!.id, quantity: '1' });
    addLine(dentist, inv, { service_id: services[1 + i]!.id, quantity: '1' });
    issueInvoice(rec, inv);
    recordPayment(rec, inv, { payment_id: newId(), amount: i === 0 ? '2000.00' : '1000.00', method: i === 0 ? 'cash' : 'e_wallet', reference: i === 0 ? '' : 'DEMO-REF-001' });
  }
  return { ctxs: { rec, dentist } };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).includes(`${path.sep}seed-demo`);
if (isMain) {
  if (fs.existsSync(path.join(PROJECT_ROOT, '.env'))) process.loadEnvFile(path.join(PROJECT_ROOT, '.env'));
  const cfg = loadConfig();
  const password = process.env.DEMO_PASSWORD;
  if (!password) {
    console.error('Set DEMO_PASSWORD (see .env.example) before seeding.');
    process.exit(1);
  }
  const db = openDatabase(cfg.dbFile);
  try {
    await seedDemo(db, password);
    if (!fs.existsSync(cfg.backupKeyFile)) generateKeyFile(cfg.backupKeyFile);
    console.log(`Demo data created in ${cfg.dbFile}. Accounts: owner|manager|dentist1|dentist2|reception|reception2|inventory @${DEMO_DOMAIN}, password from DEMO_PASSWORD.`);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
