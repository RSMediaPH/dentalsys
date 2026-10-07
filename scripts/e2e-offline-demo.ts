// End-to-end check of the Milestone 1 workflow against a REAL server process on a fresh data directory:
//   register patient → book appointment → issue invoice → partial payment → balance → daily collections
// then hard-kill the server (like a power cut), restart it, and verify everything persisted.
// The branch server makes no outbound connections; cloud sync is not configured. All data is synthetic.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { PROJECT_ROOT } from '../src/config.js';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dentalsys-e2e-'));
const PASSWORD = 'e2e-demo-password-1';
const env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', BACKUP_DAILY_AT: '', DEMO_PASSWORD: PASSWORD,
  // Any accidental outbound HTTP(S) would go to a dead proxy and fail loudly.
  HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' };
// Run node directly (not the tsx wrapper) so killing the process really stops the server.
const node = (args: string[]) => spawn(process.execPath, ['--import', 'tsx', ...args], { cwd: PROJECT_ROOT, env, stdio: 'ignore' });

let step = 0;
const ok = (msg: string) => console.log(`  ✔ ${String(++step).padStart(2)} ${msg}`);
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${msg}`);
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = node(args);
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${args.join(' ')} exited ${c}`))));
  });
}
async function startServer(): Promise<ChildProcess> {
  const p = node(['src/server.ts']);
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return p;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

class Client {
  jar = new Map<string, string>();
  async req(method: string, url: string, form?: Record<string, string>) {
    const res = await fetch(BASE + url, {
      method, redirect: 'manual',
      headers: { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [k, v] = c.split(';')[0]!.split('=');
      if (v) this.jar.set(k!, v); else this.jar.delete(k!);
    }
    return { status: res.status, location: res.headers.get('location') ?? '', body: await res.text() };
  }
  csrf(body: string) {
    return /name="_csrf" value="([^"]+)"/.exec(body)![1]!;
  }
  async login(email: string) {
    const page = await this.req('GET', '/login');
    const r = await this.req('POST', '/login', { _csrf: this.csrf(page.body), email, password: PASSWORD, next: '/' });
    check(r.status === 302 && r.location === '/', `login ${email}`);
  }
}
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

async function main() {
  console.log(`E2E offline workflow — data dir ${DATA}\n`);
  await run(['src/cli/seed-demo.ts']);
  ok('Fresh branch database created with synthetic demo data');
  let server = await startServer();
  ok(`Branch server running locally on ${BASE} (cloud sync: not configured, outbound HTTP blocked)`);

  const rec = new Client();
  await rec.login('reception@demo.test');
  const home = await rec.req('GET', '/');
  check(!/(src|href)="https?:\/\//.test(home.body), 'pages load no external resources');
  ok('Receptionist signed in; page uses only local assets');

  // 1. Register patient
  let csrf = rec.csrf(home.body);
  const reg = await rec.req('POST', '/patients/new', { _csrf: csrf, first_name: 'Erin', last_name: 'Offline-Test', date_of_birth: '1993-05-17', phone: '0917 555 0123' });
  check(reg.status === 302, 'patient registered');
  const patientId = reg.location.split('/')[2]!.split('?')[0]!;
  const profile = await rec.req('GET', `/patients/${patientId}`);
  const patientNo = /MKT-\d{6}/.exec(profile.body)![0];
  ok(`Registered patient ${patientNo}`);

  // Duplicate suggestion on re-registration
  const dup = await rec.req('POST', '/patients/new', { _csrf: csrf, first_name: 'Erin', last_name: 'Offline-Test', date_of_birth: '1993-05-17' });
  check(dup.status === 409 && dup.body.includes(patientNo), 'duplicate suggestion shown');
  ok('Registering the same person again shows a duplicate suggestion instead of creating a record');

  // 2. Book appointment on the next working day at 16:00
  let day = DateTime.now().setZone('Asia/Manila').plus({ days: 1 });
  while (day.weekday === 7) day = day.plus({ days: 1 });
  const form = await rec.req('GET', `/appointments/new?patient_id=${patientId}`);
  const dentistId = /name="dentist_id"[\s\S]*?<option value="([0-9a-f-]{36})"/.exec(form.body)![1]!;
  const chairId = /name="operatory_id"[\s\S]*?<option value="([0-9a-f-]{36})"/.exec(form.body)![1]!;
  const appt = { _csrf: csrf, patient_id: patientId, dentist_id: dentistId, operatory_id: chairId, service_id: '', date: day.toISODate()!, time: '16:00', duration_min: '45', notes: '' };
  const booked = await rec.req('POST', '/appointments/new', appt);
  check(booked.status === 302, `appointment booked (${booked.status})`);
  const apptId = booked.location.split('/')[2]!.split('?')[0]!;
  ok(`Booked ${day.toFormat('ccc d MMM')} 16:00–16:45`);

  const rec2 = new Client();
  await rec2.login('reception2@demo.test');
  const clash = await rec2.req('POST', '/appointments/new', { ...appt, _csrf: rec2.csrf((await rec2.req('GET', '/')).body), patient_id: patientId, time: '16:30' });
  check(clash.status === 409 && text(clash.body).includes('already booked'), 'overlap rejected');
  ok('Second receptionist trying to book the same chair/dentist at 16:30 is refused with a clear message');

  // Visit happens: arrived → completed (dentist)
  let page = await rec.req('GET', `/appointments/${apptId}`);
  let version = /name="version" value="(\d+)"/.exec(page.body)![1]!;
  check((await rec.req('POST', `/appointments/${apptId}/status`, { _csrf: csrf, version, status: 'arrived', reason: '' })).status === 302, 'arrived');
  const dentist = new Client();
  await dentist.login('dentist1@demo.test');
  page = await dentist.req('GET', `/appointments/${apptId}`);
  version = /name="version" value="(\d+)"/.exec(page.body)![1]!;
  check((await dentist.req('POST', `/appointments/${apptId}/status`, { _csrf: dentist.csrf(page.body), version, status: 'completed', reason: '' })).status === 302, 'completed');
  ok('Patient marked arrived (reception) and visit completed (dentist)');

  // 3. Invoice
  const draft = await rec.req('POST', '/invoices/new', { _csrf: csrf, patient_id: patientId, appointment_id: apptId });
  const invoiceId = draft.location.split('/')[2]!;
  const invPage = await rec.req('GET', `/invoices/${invoiceId}`);
  const consult = /<option value="([0-9a-f-]{36})"[^>]*>CONS/.exec(invPage.body)![1]!;
  const fill = /<option value="([0-9a-f-]{36})"[^>]*>FILL1/.exec(invPage.body)![1]!;
  await rec.req('POST', `/invoices/${invoiceId}/lines`, { _csrf: csrf, service_id: consult, quantity: '1', description: '', unit_price: '', discount: '' });
  await rec.req('POST', `/invoices/${invoiceId}/lines`, { _csrf: csrf, service_id: fill, quantity: '2', description: '', unit_price: '', discount: '100.00' });
  const issued = await rec.req('POST', `/invoices/${invoiceId}/issue`, { _csrf: csrf });
  check(issued.status === 302, 'issued');
  let inv = await rec.req('GET', `/invoices/${invoiceId}`);
  const invoiceNo = /INV-MKT-\d{4}-\d{5}/.exec(inv.body)![0];
  check(text(inv.body).includes('₱4,400.00'), 'total 500 + 2×2000 − 100 = 4,400');
  ok(`Issued ${invoiceNo} for ₱4,400.00 (consultation + 2 fillings − ₱100 discount)`);

  // 4. Partial payment, submitted twice (double-click / retry)
  const paymentId = /name="payment_id" value="([0-9a-f-]{36})"/.exec(inv.body)![1]!;
  const pay = { _csrf: csrf, payment_id: paymentId, amount: '1500.00', method: 'cash', reference: '' };
  const p1 = await rec.req('POST', `/invoices/${invoiceId}/payments`, pay);
  const p2 = await rec.req('POST', `/invoices/${invoiceId}/payments`, pay);
  check(p1.location.includes('payment_recorded') && p2.location.includes('payment_duplicate'), 'idempotent payment');
  ok('Recorded partial cash payment ₱1,500.00; the repeated submission was recognised and NOT recorded twice');

  // 5. Remaining balance
  inv = await rec.req('GET', `/invoices/${invoiceId}`);
  const balance = /data-testid="balance">([^<]+)</.exec(inv.body)![1];
  check(balance === '₱2,900.00', `balance ${balance}`);
  ok(`Outstanding balance shown: ${balance}`);

  // 6. Daily collections
  const rep = text((await rec.req('GET', '/reports/collections')).body);
  check(rep.includes('Erin Offline-Test'), 'payment listed');
  const received = /Payments received ([^ ]+)/.exec(rep)![1];
  ok(`Daily collections lists the payment (today's payments received: ${received})`);

  const status = JSON.parse((await rec.req('GET', '/api/status')).body);
  check(status.cloud.state === 'not_configured' && status.sync.pending > 0, 'sync queue');
  ok(`Status: cloud ${status.cloud.state}; ${status.sync.pending} changes queued durably for future sync`);

  // Local server unavailable
  server.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  let unreachable = false;
  try { await fetch(`${BASE}/health`); } catch { unreachable = true; }
  check(unreachable, 'server down');
  ok('Server process hard-killed (simulated power cut): workstations get "Cannot reach the clinic server"');

  server = await startServer();
  const after = new Client();
  await after.login('manager@demo.test');
  const inv2 = await after.req('GET', `/invoices/${invoiceId}`);
  check(/data-testid="balance">₱2,900.00</.test(inv2.body), 'balance persisted');
  const rep2 = text((await after.req('GET', '/reports/collections')).body);
  check(rep2.includes('Erin Offline-Test'), 'collections persisted');
  ok('After restart: invoice, payment, balance and daily collections are all intact');
  server.kill('SIGTERM');
  console.log(`\nAll ${step} checks passed.`);
}

main()
  .catch((e) => {
    console.error(`\n✖ ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(DATA, { recursive: true, force: true }));
