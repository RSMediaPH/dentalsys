// Test fixture: two organizations (A with two branches, B with one), staff in every role.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../src/config.js';
import { openDatabase, type DB } from '../src/db/db.js';
import { buildContext, type Ctx } from '../src/domain/context.js';
import { addDentistBlock, createBranch, createOperatory, createOrganization, createService, createStaff } from '../src/domain/orgs.js';
import { registerPatient } from '../src/domain/patients.js';
import { buildApp } from '../src/web/app.js';

export const PASSWORD = 'test-password-123';
export const MONDAY = '2030-01-07'; // a fixed future Monday, so tests do not depend on today's date
const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, open: 8 * 60, close: 20 * 60 }));

export function tempDir(prefix = 'dcm-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function fixture() {
  const dir = tempDir();
  const cfg: Config = loadConfig({ DATA_DIR: dir, BACKUP_DAILY_AT: '' });
  const db = openDatabase(cfg.dbFile);

  const orgA = createOrganization(db, { name: 'Org A (test)' });
  const a1 = createBranch(db, orgA.id, { code: 'AAA', name: 'A One', hours: ALL_WEEK });
  const a2 = createBranch(db, orgA.id, { code: 'AAB', name: 'A Two', hours: ALL_WEEK });
  const orgB = createOrganization(db, { name: 'Org B (test)' });
  const b1 = createBranch(db, orgB.id, { code: 'BBB', name: 'B One', hours: ALL_WEEK });

  const chairA1 = createOperatory(db, orgA.id, a1.id, 'Chair 1');
  const chairA2 = createOperatory(db, orgA.id, a1.id, 'Chair 2');
  const chairB = createOperatory(db, orgB.id, b1.id, 'Chair 1');
  const svcA = createService(db, orgA.id, { code: 'CONS', name: 'Consultation', durationMin: 30, priceMinor: 50000 });
  const svcB = createService(db, orgB.id, { code: 'CONS', name: 'Consultation', durationMin: 30, priceMinor: 60000 });

  const mk = (orgId: string, email: string, role: Parameters<typeof createStaff>[1]['role'], branchIds: string[]) =>
    createStaff(db, { orgId, email, displayName: email.split('@')[0]!, password: PASSWORD, role, branchIds });
  const s = {
    ownerA: await mk(orgA.id, 'owner@a.test', 'owner', []),
    managerA: await mk(orgA.id, 'manager@a.test', 'branch_manager', [a1.id]),
    dentistA: await mk(orgA.id, 'dentist@a.test', 'dentist', [a1.id]),
    dentistA2: await mk(orgA.id, 'dentist2@a.test', 'dentist', [a1.id]),
    receptionA: await mk(orgA.id, 'reception@a.test', 'receptionist', [a1.id]),
    reception2A: await mk(orgA.id, 'reception2@a.test', 'receptionist', [a1.id]),
    receptionA2only: await mk(orgA.id, 'reception-a2@a.test', 'receptionist', [a2.id]),
    inventoryA: await mk(orgA.id, 'inventory@a.test', 'inventory_staff', [a1.id]),
    receptionB: await mk(orgB.id, 'reception@b.test', 'receptionist', [b1.id]),
    dentistB: await mk(orgB.id, 'dentist@b.test', 'dentist', [b1.id]),
  };
  for (let wd = 1; wd <= 7; wd++) {
    addDentistBlock(db, orgA.id, a1.id, s.dentistA.membershipId, wd, 8 * 60, 20 * 60);
    addDentistBlock(db, orgA.id, a1.id, s.dentistA2.membershipId, wd, 8 * 60, 12 * 60);
    addDentistBlock(db, orgB.id, b1.id, s.dentistB.membershipId, wd, 8 * 60, 20 * 60);
  }
  const ctx = (who: keyof typeof s, branchId?: string): Ctx => {
    const m = s[who];
    const branch = branchId ?? (who.endsWith('B') ? b1.id : who === 'receptionA2only' ? a2.id : a1.id);
    const c = buildContext(db, m.userId, m.membershipId, branch, '127.0.0.1');
    if (!c) throw new Error(`no context for ${who}`);
    return c;
  };

  const patientA = registerPatient(ctx('receptionA'), { first_name: 'Test', last_name: 'Alpha', date_of_birth: '1990-01-01', phone: '0917 111 0001' });
  const patientB = registerPatient(ctx('receptionB'), { first_name: 'Test', last_name: 'Bravo', date_of_birth: '1991-02-02', phone: '0917 222 0002' });

  return { dir, cfg, db, orgA, orgB, a1, a2, b1, chairA1, chairA2, chairB, svcA, svcB, staff: s, ctx, patientA, patientB };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export function cleanup(f: { db: DB; dir: string }) {
  if (f.db.open) f.db.close();
  fs.rmSync(f.dir, { recursive: true, force: true });
}

export function booking(f: Fixture, over: Record<string, string> = {}) {
  return { patient_id: f.patientA.id, dentist_id: f.staff.dentistA.membershipId, operatory_id: f.chairA1, service_id: f.svcA, date: MONDAY, time: '09:00', duration_min: '30', ...over };
}

// ---------- HTTP helpers (Fastify inject; no network) ----------
export class Browser {
  cookies = new Map<string, string>();
  constructor(readonly app: FastifyInstance) {}
  private cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  private absorb(res: { headers: Record<string, unknown> }) {
    const sc = res.headers['set-cookie'];
    for (const c of (Array.isArray(sc) ? sc : sc ? [sc] : []) as string[]) {
      const [kv] = c.split(';');
      const [k, ...v] = kv!.split('=');
      if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c) || v.join('=') === '') this.cookies.delete(k!.trim());
      else this.cookies.set(k!.trim(), v.join('='));
    }
  }
  async get(url: string) {
    const res = await this.app.inject({ method: 'GET', url, headers: { cookie: this.cookieHeader() } });
    this.absorb(res);
    return res;
  }
  async post(url: string, form: Record<string, string>, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method: 'POST', url, payload: new URLSearchParams(form).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: this.cookieHeader(), ...headers },
    });
    this.absorb(res);
    return res;
  }
  static csrfFrom(body: string): string {
    const m = /name="_csrf" value="([^"]+)"/.exec(body);
    if (!m) throw new Error('no csrf token in page');
    return m[1]!;
  }
  async login(email: string, password = PASSWORD) {
    const page = await this.get('/login');
    return this.post('/login', { _csrf: Browser.csrfFrom(page.body), email, password, next: '/' });
  }
  async csrf() {
    return Browser.csrfFrom((await this.get('/switch-branch')).body);
  }
}

export async function httpApp(f: Fixture) {
  return buildApp({ db: f.db, cfg: f.cfg }, { logger: false });
}
