// Organization-level records that every branch of an organization needs a copy of
// (so staff can sign in and work at any of their branches, offline).
// Changes are emitted as outbox events once the server is connected to the cloud;
// before that, `orgSnapshot` produces the full set at enrollment time.
//
// Ordering is decided by the cloud's cursor, never by device clocks.
import type { DB } from '../db/db.js';
import { tx } from '../db/db.js';
import { APP_VERSION, EVENT_SCHEMA_VERSION } from '../config.js';
import { newId, nowIso } from '../lib/core.js';

import { type OrgEntityType } from './protocol.js';
export { ORG_ENTITY_TYPES, isOrgEntityType, type OrgEntityType } from './protocol.js';

type Row = Record<string, unknown>;

/** Current state of one org-level record, as a sync payload. */
export function readOrgEntity(db: DB, type: OrgEntityType, id: string): Row | null {
  switch (type) {
    case 'organization':
      return (db.prepare('SELECT * FROM organizations WHERE id = ?').get(id) as Row) ?? null;
    case 'branch': {
      const b = db.prepare('SELECT * FROM branches WHERE id = ?').get(id) as Row | undefined;
      if (!b) return null;
      return { ...b, hours: db.prepare('SELECT weekday, open_min, close_min FROM branch_hours WHERE branch_id = ? ORDER BY weekday').all(id) };
    }
    case 'user':
      return (db.prepare('SELECT id, email, display_name, password_hash, is_active, session_version, created_at FROM users WHERE id = ?').get(id) as Row) ?? null;
    case 'membership': {
      const m = db.prepare('SELECT * FROM memberships WHERE id = ?').get(id) as Row | undefined;
      if (!m) return null;
      return { ...m, branch_ids: db.prepare('SELECT branch_id FROM membership_branches WHERE membership_id = ? ORDER BY branch_id').pluck().all(id) };
    }
    case 'service':
      return (db.prepare('SELECT * FROM services WHERE id = ?').get(id) as Row) ?? null;
    case 'operatory':
      return (db.prepare('SELECT * FROM operatories WHERE id = ?').get(id) as Row) ?? null;
    case 'dentist_schedule':
      return (db.prepare('SELECT * FROM dentist_schedules WHERE id = ?').get(id) as Row) ?? null;
  }
}

/** Every org-level record, parents first (organization → branches → users → memberships → …). */
export function orgSnapshot(db: DB, orgId: string): { type: OrgEntityType; id: string }[] {
  const ids = (sql: string) => db.prepare(sql).pluck().all(orgId) as string[];
  return [
    { type: 'organization' as const, id: orgId },
    ...ids('SELECT id FROM branches WHERE org_id = ? ORDER BY created_at').map((id) => ({ type: 'branch' as const, id })),
    ...ids('SELECT DISTINCT u.id FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.org_id = ?').map((id) => ({ type: 'user' as const, id })),
    ...ids('SELECT id FROM memberships WHERE org_id = ?').map((id) => ({ type: 'membership' as const, id })),
    ...ids('SELECT id FROM services WHERE org_id = ?').map((id) => ({ type: 'service' as const, id })),
    ...ids('SELECT id FROM operatories WHERE org_id = ?').map((id) => ({ type: 'operatory' as const, id })),
    ...ids('SELECT id FROM dentist_schedules WHERE org_id = ?').map((id) => ({ type: 'dentist_schedule' as const, id })),
  ];
}

export function syncIdentity(db: DB): { orgId: string; branchId: string; nodeId: string } | null {
  const s = Object.fromEntries((db.prepare(`SELECT key, value FROM sync_state WHERE key IN ('org_id','branch_id')`).all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  if (!s.org_id || !s.branch_id) return null;
  return { orgId: s.org_id, branchId: s.branch_id, nodeId: db.prepare('SELECT id FROM node_identity').pluck().get() as string };
}

/** Insert one org-entity event into the outbox (must be inside a transaction). */
export function insertOrgEntityEvent(db: DB, ident: { orgId: string; branchId: string; nodeId: string }, type: OrgEntityType, id: string, actorUserId: string | null): void {
  const payload = readOrgEntity(db, type, id);
  if (!payload) return;
  db.prepare(
    `INSERT INTO outbox_events (id, org_id, branch_id, node_id, entity_type, entity_id, op, payload_json, schema_version, app_version, created_at, actor_user_id)
     VALUES (?, ?, ?, ?, ?, ?, 'upsert', ?, ?, ?, ?, ?)`,
  ).run(newId(), ident.orgId, ident.branchId, ident.nodeId, type, id, JSON.stringify(payload), EVENT_SCHEMA_VERSION, APP_VERSION, nowIso(), actorUserId);
}

/**
 * Call after changing an org-level record. No-op until this server is connected to the cloud
 * (the enrollment snapshot covers earlier changes). Runs in the caller's transaction if there is one.
 */
export function emitOrgEntity(db: DB, type: OrgEntityType, id: string, actorUserId: string | null = null): void {
  const ident = syncIdentity(db);
  if (!ident) return;
  const run = () => insertOrgEntityEvent(db, ident, type, id, actorUserId);
  if (db.inTransaction) run();
  else tx(db, run);
}

const num = (v: unknown) => Number(v ?? 0);

/** Apply a replicated org-level record from the cloud (inside the download transaction). */
export function applyOrgEntity(db: DB, type: OrgEntityType, p: Row): void {
  switch (type) {
    case 'organization':
      db.prepare(`INSERT INTO organizations (id, name, currency, default_timezone, date_format, tooth_numbering, created_at) VALUES (@id, @name, @currency, @default_timezone, @date_format, @tooth_numbering, @created_at)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, currency = excluded.currency, default_timezone = excluded.default_timezone, date_format = excluded.date_format, tooth_numbering = excluded.tooth_numbering`).run(p);
      return;
    case 'branch': {
      db.prepare(`INSERT INTO branches (id, org_id, code, name, address, phone, email, timezone, created_at) VALUES (@id, @org_id, @code, @name, @address, @phone, @email, @timezone, @created_at)
        ON CONFLICT(id) DO UPDATE SET code = excluded.code, name = excluded.name, address = excluded.address, phone = excluded.phone, email = excluded.email, timezone = excluded.timezone`).run(p);
      db.prepare('DELETE FROM branch_hours WHERE branch_id = ?').run(p.id);
      const ins = db.prepare('INSERT INTO branch_hours (branch_id, weekday, open_min, close_min) VALUES (?, ?, ?, ?)');
      for (const h of (p.hours as Row[]) ?? []) ins.run(p.id, num(h.weekday), num(h.open_min), num(h.close_min));
      return;
    }
    case 'user': {
      const before = db.prepare('SELECT session_version, is_active FROM users WHERE id = ?').get(p.id) as { session_version: number; is_active: number } | undefined;
      db.prepare(`INSERT INTO users (id, email, display_name, password_hash, is_active, session_version, created_at) VALUES (@id, @email, @display_name, @password_hash, @is_active, @session_version, @created_at)
        ON CONFLICT(id) DO UPDATE SET email = excluded.email, display_name = excluded.display_name, password_hash = excluded.password_hash,
          is_active = excluded.is_active, session_version = MAX(users.session_version, excluded.session_version)`).run(p);
      // A revocation made elsewhere takes effect here as soon as it arrives.
      if (before && (num(p.session_version) > before.session_version || !num(p.is_active))) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(p.id);
      return;
    }
    case 'membership': {
      db.prepare(`INSERT INTO memberships (id, user_id, org_id, role, is_active, created_at) VALUES (@id, @user_id, @org_id, @role, @is_active, @created_at)
        ON CONFLICT(id) DO UPDATE SET role = excluded.role, is_active = excluded.is_active`).run(p);
      db.prepare('DELETE FROM membership_branches WHERE membership_id = ?').run(p.id);
      const ins = db.prepare('INSERT OR IGNORE INTO membership_branches (membership_id, branch_id) SELECT ?, id FROM branches WHERE id = ?');
      for (const b of (p.branch_ids as string[]) ?? []) ins.run(p.id, b);
      if (!num(p.is_active)) db.prepare('DELETE FROM sessions WHERE membership_id = ?').run(p.id);
      return;
    }
    case 'service':
      db.prepare(`INSERT INTO services (id, org_id, code, name, default_duration_min, price_minor, is_active) VALUES (@id, @org_id, @code, @name, @default_duration_min, @price_minor, @is_active)
        ON CONFLICT(id) DO UPDATE SET code = excluded.code, name = excluded.name, default_duration_min = excluded.default_duration_min, price_minor = excluded.price_minor, is_active = excluded.is_active`).run(p);
      return;
    case 'operatory':
      db.prepare(`INSERT INTO operatories (id, org_id, branch_id, name, is_active) VALUES (@id, @org_id, @branch_id, @name, @is_active)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_active = excluded.is_active`).run(p);
      return;
    case 'dentist_schedule':
      db.prepare(`INSERT INTO dentist_schedules (id, org_id, branch_id, membership_id, weekday, start_min, end_min) VALUES (@id, @org_id, @branch_id, @membership_id, @weekday, @start_min, @end_min)
        ON CONFLICT(id) DO UPDATE SET weekday = excluded.weekday, start_min = excluded.start_min, end_min = excluded.end_min`).run(p);
      return;
  }
}
