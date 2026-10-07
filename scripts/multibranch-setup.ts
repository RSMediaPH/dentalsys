// Sets up a LOCAL multi-branch demo on this computer (synthetic data):
//   demo-multibranch/cloud  — cloud service database (PGlite)
//   demo-multibranch/a      — branch A server data (Demo Branch Main, seeded)
//   demo-multibranch/b      — branch B server data (joined via a connection code)
// Then start the three servers (see docs/11-cloud-setup.md → "Try it locally").
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PROJECT_ROOT } from '../src/config.js';
import { pgliteSql } from '../src/cloud/sql.js';
import { createInvite, migrateCloud } from '../src/cloud/store.js';

const ROOT = path.join(PROJECT_ROOT, 'demo-multibranch');
const CLOUD_PORT = 9090;
if (fs.existsSync(ROOT)) {
  console.error(`${ROOT} already exists. Delete that folder to start over.`);
  process.exit(1);
}
fs.mkdirSync(ROOT);
if (fs.existsSync(path.join(PROJECT_ROOT, '.env'))) process.loadEnvFile(path.join(PROJECT_ROOT, '.env'));
const password = process.env.DEMO_PASSWORD;
if (!password) throw new Error('Set DEMO_PASSWORD in .env first.');

const run = (args: string[], env: Record<string, string>) => new Promise<void>((resolve, reject) => {
  const p = spawn(process.execPath, ['--import', 'tsx', ...args], { cwd: PROJECT_ROOT, env: { ...process.env, ...env }, stdio: 'inherit' });
  p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${args.join(' ')} failed`))));
});

// 1. Cloud database + one-time codes (created before the cloud server starts; PGlite allows one process).
const sql = await pgliteSql(path.join(ROOT, 'cloud'));
await migrateCloud(sql);
const newOrg = await createInvite(sql, { kind: 'new_org' });
await sql.close();

// 2. Start the cloud temporarily to enroll both branches.
const cloud = spawn(process.execPath, ['--import', 'tsx', 'src/cloud/server.ts'], {
  cwd: PROJECT_ROOT, env: { ...process.env, CLOUD_DATA_DIR: path.join(ROOT, 'cloud'), CLOUD_PORT: String(CLOUD_PORT) }, stdio: 'ignore',
});
const url = `http://127.0.0.1:${CLOUD_PORT}`;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 100));
}
try {
  const A = { DATA_DIR: path.join(ROOT, 'a'), DEMO_PASSWORD: password };
  const B = { DATA_DIR: path.join(ROOT, 'b'), DEMO_PASSWORD: password };
  await run(['src/cli/seed-demo.ts'], A);
  await run(['src/cli/cloud-connect.ts', url, newOrg.code], A);
  cloud.kill();
  await new Promise((r) => setTimeout(r, 500));

  // Branch B invite needs the organization id from the cloud database.
  const sql2 = await pgliteSql(path.join(ROOT, 'cloud'));
  const [org] = await sql2.query<{ id: string }>('SELECT id FROM organizations LIMIT 1');
  const join = await createInvite(sql2, { kind: 'join_branch', orgId: org!.id, branchCode: 'BGC', branchName: 'Demo Branch Two' });
  await sql2.close();
  const cloud2 = spawn(process.execPath, ['--import', 'tsx', 'src/cloud/server.ts'], {
    cwd: PROJECT_ROOT, env: { ...process.env, CLOUD_DATA_DIR: path.join(ROOT, 'cloud'), CLOUD_PORT: String(CLOUD_PORT) }, stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    await run(['src/cli/cloud-connect.ts', url, join.code], B);
    await run(['src/cli/branch-admin.ts', 'add-chair', 'Chair 1'], B);
    await run(['src/cli/branch-admin.ts', 'add-chair', 'Chair 2'], B);
    for (const e of ['reception2@demo.test', 'dentist2@demo.test', 'manager@demo.test']) await run(['src/cli/branch-admin.ts', 'assign', e], B);
    await run(['src/cli/branch-admin.ts', 'dentist-hours', 'dentist2@demo.test', '1-6', '09:00', '18:00'], B);
  } finally {
    cloud2.kill();
  }
  console.log(`\nLocal multi-branch demo ready in ${ROOT}`);
  console.log('Start: cloud (port 9090), branch A (port 8080), branch B (port 8081) — see docs/11-cloud-setup.md.');
} catch (e) {
  cloud.kill();
  throw e;
}
