-- 002_sync: Milestone 2 branch-side synchronization support.

-- Who caused each event (needed to attribute replicated records at other branches,
-- and to flag events from revoked users).
ALTER TABLE outbox_events ADD COLUMN actor_user_id TEXT;

-- The cloud's version of each shared patient record that this server last applied.
-- 0 = never confirmed by the cloud. Edits send it as their base for conflict detection.
ALTER TABLE patients ADD COLUMN cloud_version INTEGER NOT NULL DEFAULT 0;

-- Conflicts detected by the cloud (e.g. the same patient field changed differently at two branches).
CREATE TABLE sync_conflicts (
  id               TEXT PRIMARY KEY,         -- cloud conflict id
  org_id           TEXT NOT NULL,
  entity_type      TEXT NOT NULL,
  entity_id        TEXT NOT NULL,
  field            TEXT NOT NULL,
  kept_value       TEXT,                     -- value currently in the shared record
  incoming_value   TEXT,                     -- value that was NOT applied
  incoming_branch  TEXT,
  incoming_actor   TEXT,
  detected_at      TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('open','resolved')),
  resolved_at      TEXT,
  resolved_by      TEXT,
  resolution       TEXT
);
CREATE INDEX sync_conflicts_open ON sync_conflicts(org_id, status);

-- What this server knows about every branch's synchronization (from the cloud).
CREATE TABLE remote_branch_status (
  branch_id          TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  last_event_at      TEXT,     -- cloud time when the cloud last received data from that branch
  last_seen_at       TEXT,     -- cloud time when that branch last contacted the cloud
  app_version        TEXT,
  updated_at         TEXT NOT NULL
);
