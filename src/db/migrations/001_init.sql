-- 001_init: branch-server schema for Milestone 1.
-- Conventions:
--   * IDs are UUIDv7 text. Timestamps are ISO-8601 UTC text ('2026-10-07T02:30:00.000Z').
--   * Money is INTEGER minor units (centavos); currency lives on organizations.
--   * Every tenant record carries org_id; branch-owned records also carry branch_id.
--   * Financial and audit tables are append-only (enforced by triggers below).

CREATE TABLE node_identity (
  id            TEXT PRIMARY KEY,           -- this server installation
  created_at    TEXT NOT NULL
);

CREATE TABLE organizations (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'PHP',
  default_timezone TEXT NOT NULL DEFAULT 'Asia/Manila',
  date_format      TEXT NOT NULL DEFAULT 'd MMM yyyy',
  tooth_numbering  TEXT NOT NULL DEFAULT 'FDI' CHECK (tooth_numbering IN ('FDI','UNIVERSAL','PALMER')),
  created_at       TEXT NOT NULL
);

CREATE TABLE branches (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  code        TEXT NOT NULL CHECK (code GLOB '[A-Z][A-Z0-9]*' AND length(code) BETWEEN 2 AND 6),
  name        TEXT NOT NULL,
  address     TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  timezone    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (org_id, code)
);

-- Operating hours. weekday: 1=Monday … 7=Sunday (ISO). Minutes from local midnight.
CREATE TABLE branch_hours (
  branch_id  TEXT NOT NULL REFERENCES branches(id),
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  open_min   INTEGER NOT NULL CHECK (open_min BETWEEN 0 AND 1440),
  close_min  INTEGER NOT NULL CHECK (close_min BETWEEN 0 AND 1440),
  PRIMARY KEY (branch_id, weekday),
  CHECK (close_min > open_min)
);

CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name     TEXT NOT NULL,
  password_hash    TEXT NOT NULL,
  is_active        INTEGER NOT NULL DEFAULT 1,
  session_version  INTEGER NOT NULL DEFAULT 1,  -- bump to revoke all sessions
  created_at       TEXT NOT NULL
);

-- A user's role within one organization.
CREATE TABLE memberships (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  role        TEXT NOT NULL CHECK (role IN ('owner','branch_manager','dentist','receptionist','inventory_staff')),
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, org_id)
);

CREATE TABLE membership_branches (
  membership_id TEXT NOT NULL REFERENCES memberships(id),
  branch_id     TEXT NOT NULL REFERENCES branches(id),
  PRIMARY KEY (membership_id, branch_id)
);

CREATE TABLE sessions (
  token_hash       TEXT PRIMARY KEY,         -- SHA-256 of the cookie token; raw token never stored
  user_id          TEXT NOT NULL REFERENCES users(id),
  membership_id    TEXT NOT NULL REFERENCES memberships(id),
  branch_id        TEXT NOT NULL REFERENCES branches(id),
  csrf_token       TEXT NOT NULL,
  session_version  INTEGER NOT NULL,
  created_at       TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  expires_at       TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL,                  -- 'email:<lowercased>' or 'ip:<addr>'
  at         TEXT NOT NULL,
  success    INTEGER NOT NULL
);
CREATE INDEX login_attempts_key_at ON login_attempts(key, at);

CREATE TABLE operatories (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id),
  branch_id  TEXT NOT NULL REFERENCES branches(id),
  name       TEXT NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  UNIQUE (branch_id, name)
);

-- Dentist working blocks at a branch (recurring weekly).
CREATE TABLE dentist_schedules (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id),
  branch_id      TEXT NOT NULL REFERENCES branches(id),
  membership_id  TEXT NOT NULL REFERENCES memberships(id),
  weekday        INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_min      INTEGER NOT NULL,
  end_min        INTEGER NOT NULL,
  CHECK (end_min > start_min)
);
CREATE INDEX dentist_schedules_lookup ON dentist_schedules(branch_id, membership_id, weekday);

CREATE TABLE sequences (
  branch_id   TEXT NOT NULL REFERENCES branches(id),
  kind        TEXT NOT NULL,                 -- 'patient' | 'invoice:2026' | 'payment:2026'
  next_value  INTEGER NOT NULL,
  PRIMARY KEY (branch_id, kind)
);

CREATE TABLE patients (
  id                       TEXT PRIMARY KEY,
  org_id                   TEXT NOT NULL REFERENCES organizations(id),
  patient_no               TEXT NOT NULL,
  registered_branch_id     TEXT NOT NULL REFERENCES branches(id),
  first_name               TEXT NOT NULL,
  middle_name              TEXT NOT NULL DEFAULT '',
  last_name                TEXT NOT NULL,
  sex                      TEXT NOT NULL DEFAULT '' CHECK (sex IN ('','female','male','other')),
  date_of_birth            TEXT NOT NULL,     -- yyyy-mm-dd
  phone                    TEXT NOT NULL DEFAULT '',
  email                    TEXT NOT NULL DEFAULT '',
  address                  TEXT NOT NULL DEFAULT '',
  emergency_contact_name   TEXT NOT NULL DEFAULT '',
  emergency_contact_phone  TEXT NOT NULL DEFAULT '',
  guardian_name            TEXT NOT NULL DEFAULT '',
  guardian_relationship    TEXT NOT NULL DEFAULT '',
  guardian_phone           TEXT NOT NULL DEFAULT '',
  allergies                TEXT NOT NULL DEFAULT '',
  medications              TEXT NOT NULL DEFAULT '',
  medical_history          TEXT NOT NULL DEFAULT '',
  -- search helpers (derived, lower-case, accents stripped / digits only)
  search_name              TEXT NOT NULL,
  search_phone             TEXT NOT NULL DEFAULT '',
  merged_into_id           TEXT REFERENCES patients(id),
  version                  INTEGER NOT NULL DEFAULT 1,
  created_at               TEXT NOT NULL,
  created_by               TEXT NOT NULL REFERENCES users(id),
  updated_at               TEXT NOT NULL,
  updated_by               TEXT NOT NULL REFERENCES users(id),
  UNIQUE (org_id, patient_no)
);
CREATE INDEX patients_search_name ON patients(org_id, search_name);
CREATE INDEX patients_search_phone ON patients(org_id, search_phone);
CREATE INDEX patients_dob ON patients(org_id, date_of_birth);

CREATE TABLE services (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES organizations(id),
  code                  TEXT NOT NULL,
  name                  TEXT NOT NULL,
  default_duration_min  INTEGER NOT NULL DEFAULT 30 CHECK (default_duration_min BETWEEN 5 AND 480),
  price_minor           INTEGER NOT NULL CHECK (price_minor >= 0),
  is_active             INTEGER NOT NULL DEFAULT 1,
  UNIQUE (org_id, code)
);

CREATE TABLE appointments (
  id                     TEXT PRIMARY KEY,
  org_id                 TEXT NOT NULL REFERENCES organizations(id),
  branch_id              TEXT NOT NULL REFERENCES branches(id),
  patient_id             TEXT NOT NULL REFERENCES patients(id),
  dentist_membership_id  TEXT NOT NULL REFERENCES memberships(id),
  operatory_id           TEXT NOT NULL REFERENCES operatories(id),
  service_id             TEXT REFERENCES services(id),
  start_at               TEXT NOT NULL,       -- UTC
  end_at                 TEXT NOT NULL,       -- UTC
  status                 TEXT NOT NULL CHECK (status IN ('scheduled','confirmed','arrived','in_progress','completed','cancelled','no_show')),
  notes                  TEXT NOT NULL DEFAULT '',
  version                INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL REFERENCES users(id),
  updated_at             TEXT NOT NULL,
  updated_by             TEXT NOT NULL REFERENCES users(id),
  CHECK (end_at > start_at)
);
CREATE INDEX appointments_branch_time ON appointments(branch_id, start_at);
CREATE INDEX appointments_dentist_time ON appointments(dentist_membership_id, start_at);
CREATE INDEX appointments_operatory_time ON appointments(operatory_id, start_at);
CREATE INDEX appointments_patient ON appointments(patient_id);

-- Database-level guarantee: no two active appointments overlap for the same dentist or chair.
-- (The application checks first to give a friendly message; this is the safety net.)
CREATE TRIGGER appointments_no_overlap_insert
BEFORE INSERT ON appointments
WHEN NEW.status NOT IN ('cancelled','no_show')
BEGIN
  SELECT RAISE(ABORT, 'APPOINTMENT_OVERLAP')
  WHERE EXISTS (
    SELECT 1 FROM appointments a
    WHERE a.branch_id = NEW.branch_id
      AND a.status NOT IN ('cancelled','no_show')
      AND (a.dentist_membership_id = NEW.dentist_membership_id OR a.operatory_id = NEW.operatory_id)
      AND a.start_at < NEW.end_at AND a.end_at > NEW.start_at
  );
END;

CREATE TRIGGER appointments_no_overlap_update
BEFORE UPDATE OF start_at, end_at, dentist_membership_id, operatory_id, status ON appointments
WHEN NEW.status NOT IN ('cancelled','no_show')
BEGIN
  SELECT RAISE(ABORT, 'APPOINTMENT_OVERLAP')
  WHERE EXISTS (
    SELECT 1 FROM appointments a
    WHERE a.id <> NEW.id
      AND a.branch_id = NEW.branch_id
      AND a.status NOT IN ('cancelled','no_show')
      AND (a.dentist_membership_id = NEW.dentist_membership_id OR a.operatory_id = NEW.operatory_id)
      AND a.start_at < NEW.end_at AND a.end_at > NEW.start_at
  );
END;

CREATE TABLE appointment_events (
  id              TEXT PRIMARY KEY,
  appointment_id  TEXT NOT NULL REFERENCES appointments(id),
  org_id          TEXT NOT NULL,
  at              TEXT NOT NULL,
  actor_user_id   TEXT NOT NULL REFERENCES users(id),
  kind            TEXT NOT NULL,             -- created | status_changed | rescheduled
  details_json    TEXT NOT NULL,
  reason          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX appointment_events_appt ON appointment_events(appointment_id, at);
CREATE TRIGGER appointment_events_no_update BEFORE UPDATE ON appointment_events
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
CREATE TRIGGER appointment_events_no_delete BEFORE DELETE ON appointment_events
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;

CREATE TABLE invoices (
  id                     TEXT PRIMARY KEY,
  org_id                 TEXT NOT NULL REFERENCES organizations(id),
  branch_id              TEXT NOT NULL REFERENCES branches(id),
  invoice_no             TEXT,                -- assigned at issue
  patient_id             TEXT NOT NULL REFERENCES patients(id),
  dentist_membership_id  TEXT REFERENCES memberships(id),
  appointment_id         TEXT REFERENCES appointments(id),
  status                 TEXT NOT NULL CHECK (status IN ('draft','issued','void')),
  subtotal_minor         INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  discount_minor         INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  total_minor            INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  notes                  TEXT NOT NULL DEFAULT '',
  issued_at              TEXT,
  issued_by              TEXT REFERENCES users(id),
  voided_at              TEXT,
  voided_by              TEXT REFERENCES users(id),
  void_reason            TEXT,
  created_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL REFERENCES users(id),
  CHECK (total_minor = subtotal_minor - discount_minor),
  CHECK (status = 'draft' OR (invoice_no IS NOT NULL AND issued_at IS NOT NULL)),
  UNIQUE (org_id, invoice_no)
);
CREATE INDEX invoices_patient ON invoices(patient_id);
CREATE INDEX invoices_branch_issued ON invoices(branch_id, issued_at);

-- Once issued, an invoice's financial content is frozen. Only issued -> void is allowed, once.
CREATE TRIGGER invoices_frozen_after_issue
BEFORE UPDATE ON invoices
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'INVOICE_IMMUTABLE')
  WHERE NOT (
    OLD.status = 'issued' AND NEW.status = 'void'
    AND NEW.invoice_no IS OLD.invoice_no AND NEW.subtotal_minor = OLD.subtotal_minor
    AND NEW.discount_minor = OLD.discount_minor AND NEW.total_minor = OLD.total_minor
    AND NEW.patient_id = OLD.patient_id AND NEW.branch_id = OLD.branch_id AND NEW.org_id = OLD.org_id
    AND NEW.issued_at IS OLD.issued_at AND NEW.issued_by IS OLD.issued_by
    AND NEW.void_reason IS NOT NULL AND NEW.voided_at IS NOT NULL AND NEW.voided_by IS NOT NULL
  );
END;
CREATE TRIGGER invoices_no_delete_after_issue
BEFORE DELETE ON invoices WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'INVOICE_IMMUTABLE'); END;

CREATE TABLE invoice_lines (
  id                TEXT PRIMARY KEY,
  invoice_id        TEXT NOT NULL REFERENCES invoices(id),
  service_id        TEXT REFERENCES services(id),
  description       TEXT NOT NULL,
  quantity          INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  unit_price_minor  INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  discount_minor    INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  line_total_minor  INTEGER NOT NULL CHECK (line_total_minor >= 0),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  CHECK (line_total_minor = quantity * unit_price_minor - discount_minor)
);
CREATE INDEX invoice_lines_invoice ON invoice_lines(invoice_id, sort_order);
CREATE TRIGGER invoice_lines_frozen_insert BEFORE INSERT ON invoice_lines
WHEN (SELECT status FROM invoices WHERE id = NEW.invoice_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'INVOICE_IMMUTABLE'); END;
CREATE TRIGGER invoice_lines_frozen_update BEFORE UPDATE ON invoice_lines
WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'INVOICE_IMMUTABLE'); END;
CREATE TRIGGER invoice_lines_frozen_delete BEFORE DELETE ON invoice_lines
WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'INVOICE_IMMUTABLE'); END;

CREATE TABLE payments (
  id            TEXT PRIMARY KEY,             -- generated when the form is opened: idempotency key
  org_id        TEXT NOT NULL REFERENCES organizations(id),
  branch_id     TEXT NOT NULL REFERENCES branches(id),
  payment_no    TEXT NOT NULL,
  invoice_id    TEXT NOT NULL REFERENCES invoices(id),
  patient_id    TEXT NOT NULL REFERENCES patients(id),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  method        TEXT NOT NULL CHECK (method IN ('cash','bank_transfer','card_manual','e_wallet','cheque')),
  reference     TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  received_at   TEXT NOT NULL,
  received_by   TEXT NOT NULL REFERENCES users(id),
  UNIQUE (org_id, payment_no)
);
CREATE INDEX payments_invoice ON payments(invoice_id);
CREATE INDEX payments_branch_received ON payments(branch_id, received_at);
CREATE TRIGGER payments_no_update BEFORE UPDATE ON payments
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;

-- A reversal cancels the full effect of one payment (entered in error, bounced transfer...).
CREATE TABLE payment_reversals (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id),
  branch_id    TEXT NOT NULL REFERENCES branches(id),
  payment_id   TEXT NOT NULL UNIQUE REFERENCES payments(id),
  reason       TEXT NOT NULL CHECK (length(trim(reason)) >= 5),
  reversed_at  TEXT NOT NULL,
  reversed_by  TEXT NOT NULL REFERENCES users(id)
);
CREATE INDEX payment_reversals_branch_at ON payment_reversals(branch_id, reversed_at);
CREATE TRIGGER payment_reversals_no_update BEFORE UPDATE ON payment_reversals
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
CREATE TRIGGER payment_reversals_no_delete BEFORE DELETE ON payment_reversals
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;

CREATE TABLE audit_events (
  id             TEXT PRIMARY KEY,
  org_id         TEXT,
  branch_id      TEXT,
  actor_user_id  TEXT,
  action         TEXT NOT NULL,      -- e.g. 'patient.view', 'payment.record', 'auth.login_failed'
  entity_type    TEXT NOT NULL DEFAULT '',
  entity_id      TEXT NOT NULL DEFAULT '',
  at             TEXT NOT NULL,
  ip             TEXT NOT NULL DEFAULT '',
  details_json   TEXT NOT NULL DEFAULT '{}'   -- no patient clinical content here
);
CREATE INDEX audit_events_org_at ON audit_events(org_id, at);
CREATE INDEX audit_events_entity ON audit_events(entity_type, entity_id);
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;

CREATE TABLE outbox_events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,   -- per-branch-server monotonic order
  id              TEXT NOT NULL UNIQUE,                -- UUIDv7, idempotency key at the cloud
  org_id          TEXT NOT NULL,
  branch_id       TEXT NOT NULL,
  node_id         TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  op              TEXT NOT NULL,
  entity_version  INTEGER,
  base_version    INTEGER,
  payload_json    TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  app_version     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','acked','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  acked_at        TEXT
);
CREATE INDEX outbox_status ON outbox_events(status, seq);

CREATE TABLE sync_state (
  key    TEXT PRIMARY KEY,           -- 'cloud_configured', 'last_success_at', 'download_cursor'
  value  TEXT NOT NULL
);

CREATE TABLE backup_runs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('scheduled','manual')),
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  file_name    TEXT,
  size_bytes   INTEGER,
  sha256       TEXT,
  error        TEXT,
  verified_at  TEXT,
  started_by   TEXT
);

-- Safety nets for money rules (application code checks first and gives friendly messages).
CREATE TRIGGER payments_valid_invoice_and_balance
BEFORE INSERT ON payments
BEGIN
  SELECT RAISE(ABORT, 'PAYMENT_INVALID_INVOICE')
  WHERE NOT EXISTS (
    SELECT 1 FROM invoices i
    WHERE i.id = NEW.invoice_id AND i.status = 'issued'
      AND i.org_id = NEW.org_id AND i.branch_id = NEW.branch_id AND i.patient_id = NEW.patient_id
  );
  SELECT RAISE(ABORT, 'PAYMENT_EXCEEDS_BALANCE')
  WHERE NEW.amount_minor > (SELECT total_minor FROM invoices WHERE id = NEW.invoice_id)
      - (SELECT COALESCE(SUM(p.amount_minor), 0) FROM payments p
         WHERE p.invoice_id = NEW.invoice_id
           AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id));
END;

CREATE TRIGGER payment_reversals_same_scope
BEFORE INSERT ON payment_reversals
BEGIN
  SELECT RAISE(ABORT, 'REVERSAL_SCOPE')
  WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = NEW.payment_id
                    AND p.org_id = NEW.org_id AND p.branch_id = NEW.branch_id);
END;

CREATE TRIGGER invoices_void_requires_zero_paid
BEFORE UPDATE OF status ON invoices
WHEN NEW.status = 'void'
BEGIN
  SELECT RAISE(ABORT, 'VOID_HAS_PAYMENTS')
  WHERE EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = NEW.id
                AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id));
END;
