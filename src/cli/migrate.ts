import { loadConfig } from '../config.js';
import { openDatabase, migrate } from '../db/db.js';
const cfg = loadConfig();
const db = openDatabase(cfg.dbFile, { migrate: false });
const { applied } = migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
db.close();
