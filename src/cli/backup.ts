import { loadConfig } from '../config.js';
import { openDatabase } from '../db/db.js';
import { runBackup } from '../backup/backup.js';
const cfg = loadConfig();
const db = openDatabase(cfg.dbFile);
try {
  const r = await runBackup(db, cfg, 'manual', null);
  console.log(`Backup written and verified: ${r.file}`);
  console.log(`Size ${r.sizeBytes} bytes, sha256 ${r.sha256}`);
  console.log(`Records: ${JSON.stringify(r.manifest.counts)}; files: ${r.manifest.files.length}`);
} catch (e) {
  console.error(`Backup FAILED: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
