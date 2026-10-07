# 07 — Backup and recovery

Synchronization is **not** a backup: a mistake syncs everywhere. Backups are separate, encrypted, versioned copies.

## What a backup contains

An `.dcmbak` archive holds a consistent online snapshot of the branch database (taken with SQLite's backup API while the clinic keeps working) plus every file under `data/attachments/`, with a manifest of SHA-256 checksums and record counts. The archive is encrypted with AES-256-GCM in 1 MB chunks; reordering, truncation, tampering or a wrong key are all detected on restore.

## Keys — responsibilities

* `npm run backup:keygen` creates the key **once per branch server** (`data/keys/backup.key` by default).
* **The clinic owner is responsible for keeping a copy of the key off the server** (e.g. printed and sealed, or on an encrypted USB drive in a safe). Without the key, backups cannot be restored by anyone, including the vendor. Anyone holding both the key and a backup file can read the patient data.
* The vendor does not hold clinic keys by default.

## Schedule, retention, status

* Daily at `BACKUP_DAILY_AT` (default 21:00 server time); failed runs retry every 30 minutes. Manual "Back up now" on the Admin page or `npm run backup`.
* After writing, every backup is **test-restored into a temporary folder** (decrypt, checksum every file, SQLite `integrity_check` and `foreign_key_check`, compare record counts). Only then is it marked successful.
* Retention keeps the newest `BACKUP_RETENTION` (default 14) verified backups.
* The Admin page shows last verified backup, failures, and warns when backups are on the same disk as the database. **Set `BACKUP_DIR` to a second disk/USB** in production. Cloud backup copy: Milestone 2.

## Restore (non-destructive)

```bash
npm run restore -- data/backups/<file>.dcmbak /path/to/new-empty-folder
```

The restore refuses any non-empty target, so it can never overwrite the current data. It verifies everything above and prints counts. To switch the clinic to the restored data:

1. Stop the branch server.
2. Keep the old `data` folder untouched (rename it, e.g. `data-before-restore-2026-10-07`).
3. Set `DATA_DIR` to the restored folder (or move it into place) and copy the backup key into its `keys/` folder.
4. Start the server, sign in as a manager, check recent patients/invoices and the daily collections report.

Backups record which app version and schema made them; restoring a backup from a newer version is refused with a clear message.

## Tested (automated)

* Backup → restore into a clean directory → records and a multi-megabyte attachment are byte-identical; restored database opens and serves data.
* Tampered byte, truncated file and wrong key all fail with clear errors.
* Non-empty restore target is refused. Retention removes only older verified archives.

## Still to do

Quarterly restore drill procedure (Milestone 5), restore UI for managers, cloud backup copy with separate retention (Milestone 2), alerting when no successful backup in 48 hours.
