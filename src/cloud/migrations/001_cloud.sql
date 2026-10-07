-- DentalSys cloud coordination schema (PostgreSQL / Supabase).
-- The cloud is a sync hub: it validates and stores branch events, keeps the shared patient record,
-- detects conflicts, and distributes changes to the other branches of the same organization.

CREATE TABLE organizations (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id),
  code        text NOT NULL,
  name        text NOT NULL,
  timezone    text NOT NULL DEFAULT 'Asia/Manila',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

-- One-time enrollment codes (stored hashed).
CREATE TABLE invites (
  code_hash     text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('new_org','join_branch')),
  org_id        uuid REFERENCES organizations(id),
  branch_id     uuid REFERENCES branches(id),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  used_by_node  uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'new_org' OR (org_id IS NOT NULL AND branch_id IS NOT NULL))
);

-- Enrolled branch servers. Each authenticates with node id + secret (hash stored).
CREATE TABLE nodes (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id),
  branch_id     uuid NOT NULL REFERENCES branches(id),
  secret_hash   text NOT NULL,
  enrolled_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  app_version   text
);

-- Every event ever received (idempotency key = event_id). Rejected events are kept with the reason.
CREATE TABLE events (
  event_id        uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  branch_id       uuid NOT NULL,
  node_id         uuid NOT NULL,
  seq             bigint NOT NULL,
  entity_type     text NOT NULL,
  entity_id       text NOT NULL,
  op              text NOT NULL,
  entity_version  integer,
  base_version    integer,
  actor_user_id   uuid,
  payload         jsonb NOT NULL,
  schema_version  integer NOT NULL,
  app_version     text NOT NULL,
  created_at_branch timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL CHECK (status IN ('applied','rejected')),
  reject_reason   text
);
CREATE INDEX events_org_received ON events (org_id, received_at);

-- Which branch owns each branch-owned record (appointments, invoices, payments, chairs…).
-- Keyed without org so an ID can never be claimed by a second organization.
CREATE TABLE entity_owners (
  entity_type  text NOT NULL,
  entity_id    text NOT NULL,
  org_id       uuid NOT NULL,
  branch_id    uuid NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

-- Organization-level records (staff, services, chairs, branch settings), one copy per organization.
CREATE TABLE org_entities (
  org_id       uuid NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text NOT NULL,
  payload      jsonb NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, entity_type, entity_id)
);

-- The shared patient record with per-field versions for conflict detection.
CREATE TABLE patients (
  id                    uuid PRIMARY KEY,
  org_id                uuid NOT NULL,
  patient_no            text NOT NULL,
  registered_branch_id  uuid NOT NULL,
  fields                jsonb NOT NULL,
  field_versions        jsonb NOT NULL,   -- field -> cloud version when last changed
  field_nodes           jsonb NOT NULL,   -- field -> node that last changed it
  version               integer NOT NULL,
  created_by            uuid,
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, patient_no)
);

CREATE TABLE conflicts (
  id                 uuid PRIMARY KEY,
  org_id             uuid NOT NULL,
  entity_type        text NOT NULL,
  entity_id          text NOT NULL,
  field              text NOT NULL,
  kept_value         jsonb,
  incoming_value     jsonb,
  incoming_event_id  uuid NOT NULL,
  incoming_branch_id uuid NOT NULL,
  incoming_actor     uuid,
  detected_at        timestamptz NOT NULL DEFAULT now(),
  status             text NOT NULL CHECK (status IN ('open','resolved')),
  resolved_at        timestamptz,
  resolved_by        uuid,
  resolution         text
);
CREATE INDEX conflicts_org_open ON conflicts (org_id, status);

-- Distribution log: what each branch downloads, in cursor order.
CREATE TABLE changes (
  cursor            bigserial PRIMARY KEY,
  org_id            uuid NOT NULL,
  origin_branch_id  uuid,
  kind              text NOT NULL,
  entity_type       text NOT NULL,
  entity_id         text NOT NULL,
  payload           jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX changes_org_cursor ON changes (org_id, cursor);

-- Freshness of each branch, shown on consolidated reports.
CREATE TABLE branch_status (
  branch_id      uuid PRIMARY KEY REFERENCES branches(id),
  org_id         uuid NOT NULL,
  last_event_at  timestamptz,
  last_seen_at   timestamptz,
  last_seq       bigint NOT NULL DEFAULT 0,
  app_version    text
);
