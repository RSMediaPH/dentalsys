// Organization, branch, staff and chair setup.
// In Milestone 1 these are used by the seed/provisioning CLI and tests; the admin UI is read-only.
// In Milestone 2 organization-level records become cloud-owned and are synced down to branches.
import type { DB } from '../db/db.js';
import { hashPassword, MIN_PASSWORD_LENGTH, revokeUserSessions } from '../auth/auth.js';
import type { Role } from '../auth/permissions.js';
import { forbidden, invalid, newId, nowIso } from '../lib/core.js';
import { tx } from '../db/db.js';
import type { Branch, Ctx, Organization } from './context.js';
import { audit } from './context.js';

export function createOrganization(db: DB, o: { name: string; currency?: string; timezone?: string }): Organization {
  const id = newId();
  db.prepare(
    `INSERT INTO organizations (id, name, currency, default_timezone, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, o.name, o.currency ?? 'PHP', o.timezone ?? 'Asia/Manila', nowIso());
  return db.prepare('SELECT * FROM organizations WHERE id = ?').get(id) as Organization;
}

export function createBranch(
  db: DB,
  orgId: string,
  b: { code: string; name: string; timezone?: string; address?: string; phone?: string; email?: string; hours?: { weekday: number; open: number; close: number }[] },
): Branch {
  const id = newId();
  const org = db.prepare('SELECT default_timezone FROM organizations WHERE id = ?').get(orgId) as { default_timezone: string };
  tx(db, () => {
    db.prepare(
      `INSERT INTO branches (id, org_id, code, name, address, phone, email, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, orgId, b.code, b.name, b.address ?? '', b.phone ?? '', b.email ?? '', b.timezone ?? org.default_timezone, nowIso());
    const hours = b.hours ?? [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: 9 * 60, close: 18 * 60 }));
    const ins = db.prepare('INSERT INTO branch_hours (branch_id, weekday, open_min, close_min) VALUES (?, ?, ?, ?)');
    for (const h of hours) ins.run(id, h.weekday, h.open, h.close);
  });
  return db.prepare('SELECT * FROM branches WHERE id = ?').get(id) as Branch;
}

export function createOperatory(db: DB, orgId: string, branchId: string, name: string): string {
  const id = newId();
  db.prepare('INSERT INTO operatories (id, org_id, branch_id, name) VALUES (?, ?, ?, ?)').run(id, orgId, branchId, name);
  return id;
}

export async function createStaff(
  db: DB,
  s: { orgId: string; email: string; displayName: string; password: string; role: Role; branchIds: string[] },
): Promise<{ userId: string; membershipId: string }> {
  if (s.password.length < MIN_PASSWORD_LENGTH) throw invalid(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  const hash = await hashPassword(s.password);
  return tx(db, () => {
    const email = s.email.trim().toLowerCase();
    let userId = db.prepare('SELECT id FROM users WHERE email = ?').pluck().get(email) as string | undefined;
    if (!userId) {
      userId = newId();
      db.prepare('INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
        userId, email, s.displayName, hash, nowIso(),
      );
    }
    const membershipId = newId();
    db.prepare('INSERT INTO memberships (id, user_id, org_id, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
      membershipId, userId, s.orgId, s.role, nowIso(),
    );
    for (const branchId of s.branchIds) {
      const ok = db.prepare('SELECT 1 FROM branches WHERE id = ? AND org_id = ?').get(branchId, s.orgId);
      if (!ok) throw invalid('Branch does not belong to this organization.');
      db.prepare('INSERT INTO membership_branches (membership_id, branch_id) VALUES (?, ?)').run(membershipId, branchId);
    }
    return { userId, membershipId };
  });
}

export function addDentistBlock(db: DB, orgId: string, branchId: string, membershipId: string, weekday: number, startMin: number, endMin: number): void {
  db.prepare(
    `INSERT INTO dentist_schedules (id, org_id, branch_id, membership_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId(), orgId, branchId, membershipId, weekday, startMin, endMin);
}

export function createService(db: DB, orgId: string, s: { code: string; name: string; durationMin: number; priceMinor: number }): string {
  const id = newId();
  db.prepare(
    'INSERT INTO services (id, org_id, code, name, default_duration_min, price_minor) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, orgId, s.code, s.name, s.durationMin, s.priceMinor);
  return id;
}

/** Local, immediate account deactivation (works offline). Revokes all sessions. */
export function deactivateMembership(ctx: Ctx, membershipId: string): void {
  if (!ctx.perms.has('staff.manage')) throw forbidden();
  const m = ctx.db.prepare('SELECT user_id FROM memberships WHERE id = ? AND org_id = ?').get(membershipId, ctx.org.id) as
    | { user_id: string }
    | undefined;
  if (!m) throw invalid('Staff member not found');
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE memberships SET is_active = 0 WHERE id = ?').run(membershipId);
    revokeUserSessions(ctx.db, m.user_id);
    audit(ctx, 'staff.deactivated', 'membership', membershipId);
  });
}

// ---------- Read helpers for screens ----------
export function listOperatories(ctx: Ctx): { id: string; name: string }[] {
  return ctx.db
    .prepare('SELECT id, name FROM operatories WHERE branch_id = ? AND org_id = ? AND is_active = 1 ORDER BY name')
    .all(ctx.branch.id, ctx.org.id) as { id: string; name: string }[];
}

export function listDentists(ctx: Ctx): { id: string; name: string }[] {
  return ctx.db
    .prepare(
      `SELECT m.id, u.display_name AS name FROM memberships m
       JOIN users u ON u.id = m.user_id
       JOIN membership_branches mb ON mb.membership_id = m.id
       WHERE m.org_id = ? AND mb.branch_id = ? AND m.role = 'dentist' AND m.is_active = 1 AND u.is_active = 1
       ORDER BY u.display_name`,
    )
    .all(ctx.org.id, ctx.branch.id) as { id: string; name: string }[];
}

export function branchHours(db: DB, branchId: string): Map<number, { open: number; close: number }> {
  const rows = db.prepare('SELECT weekday, open_min, close_min FROM branch_hours WHERE branch_id = ?').all(branchId) as {
    weekday: number; open_min: number; close_min: number;
  }[];
  return new Map(rows.map((r) => [r.weekday, { open: r.open_min, close: r.close_min }]));
}

export function dentistBlocks(ctx: Ctx): { membership_id: string; name: string; weekday: number; start_min: number; end_min: number }[] {
  return ctx.db
    .prepare(
      `SELECT s.membership_id, u.display_name AS name, s.weekday, s.start_min, s.end_min
       FROM dentist_schedules s JOIN memberships m ON m.id = s.membership_id JOIN users u ON u.id = m.user_id
       WHERE s.branch_id = ? AND s.org_id = ? ORDER BY u.display_name, s.weekday, s.start_min`,
    )
    .all(ctx.branch.id, ctx.org.id) as never;
}
