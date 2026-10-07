import { loadConfig } from '../config.js';
import { generateKeyFile } from '../backup/backup.js';
const cfg = loadConfig();
try {
  generateKeyFile(cfg.backupKeyFile);
  console.log(`Backup key created at ${cfg.backupKeyFile}`);
  console.log('IMPORTANT: copy this key file to a safe place away from this computer (e.g. an encrypted USB drive kept by the owner).');
  console.log('Without it, backups cannot be restored. Anyone with it AND a backup file can read patient data.');
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
