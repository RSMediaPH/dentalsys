// Usage: npm run restore -- <archive.dcmbak> <empty-target-dir> [--key <keyfile>]
import { loadConfig } from '../config.js';
import { restoreBackup } from '../backup/backup.js';
const args = process.argv.slice(2);
const keyIdx = args.indexOf('--key');
const keyFile = keyIdx >= 0 ? args.splice(keyIdx, 2)[1]! : loadConfig().backupKeyFile;
const [archive, target] = args;
if (!archive || !target) {
  console.error('Usage: npm run restore -- <archive.dcmbak> <empty-target-dir> [--key <keyfile>]');
  process.exit(2);
}
try {
  const r = restoreBackup(archive, keyFile, target);
  console.log(`Restored into ${r.targetDir}`);
  console.log(`Backup created ${r.manifest.created_at} by app ${r.manifest.app_version}; branches: ${r.manifest.branches.map((b) => b.code).join(', ')}`);
  console.log(`Integrity: ${r.integrity}; files verified: ${r.filesVerified}; records: ${JSON.stringify(r.counts)}`);
  console.log('Current data was NOT changed. To switch over: stop the server, set DATA_DIR to this folder, start the server.');
} catch (e) {
  console.error(`Restore FAILED: ${(e as Error).message}`);
  process.exit(1);
}
