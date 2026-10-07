// Connect this clinic server to the DentalSys cloud with a one-time code.
// Usage: npm run cloud:connect -- <cloud-url> <code>
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, PROJECT_ROOT } from '../config.js';
import { openDatabase } from '../db/db.js';
import { connectToCloud, syncOnce } from '../sync/worker.js';

if (fs.existsSync(path.join(PROJECT_ROOT, '.env'))) process.loadEnvFile(path.join(PROJECT_ROOT, '.env'));
const [url, code] = process.argv.slice(2);
if (!url || !code) {
  console.error('Usage: npm run cloud:connect -- <cloud-url> <connection-code>');
  process.exit(2);
}
const db = openDatabase(loadConfig().dbFile);
try {
  const res = await connectToCloud(db, url, code);
  console.log(res.kind === 'new_org'
    ? 'Connected: this server is now the first branch of its organization in the cloud.'
    : `Connected: this server is now branch ${res.branch?.code} (${res.branch?.name}).`);
  const r = await syncOnce(db);
  console.log(`First sync: ${r.state}; sent ${r.uploaded}, received ${r.downloaded}${r.rejected ? `, REJECTED ${r.rejected}` : ''}${r.error ? ` — ${r.error}` : ''}`);
  if (res.kind === 'join_branch') {
    console.log('Next: add chairs, assign staff to this branch and set dentist hours (npm run branch:admin -- help).');
  }
} catch (e) {
  console.error(`Could not connect: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
