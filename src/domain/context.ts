// The request context: who is acting, in which organization and branch, with which permissions.
// It is always built on the server from the session — never from IDs sent by the browser.
import type { DB } from '../db/db.js';
import { permissionsFor, type Permission, type Role } from '../auth/permissions.js';
import { forbidden, newId, nowIso, AppError } from '../lib/core.js';

export interface Organization {
  id: string;
  name: string;
  currency: string;
  default_timezone: string;
  date_format: string;
  tooth_numbering: string;
}
export interface Branch {
  id: string;
  org_id: string;
  code: string;
  name: string;
  address: string;
  phone: string;
  email: string;
  timezone: string;
}

export interface Ctx {
  db: DB;
  user: { id: string; email: string; display_name: string };
  membership: { id: string; role: Role };
  org: Organization;
  branch: Branch;
  assignedBranchIds: string[];
  perms: Set<Permission>;
  ip: string;
}

export const can = (ctx: Ctx, p: Permission): boolean => ctx.perms.has(p);
export function requirePerm(ctx: Ctx, p: Permission): void {
  if (!ctx.perms.has(p)) throw forbidden();
}

/**
 * Build a context for a membership + branch, verifying everything on the server:
 * user active, membership active, branch belongs to the same org and is assigned (owners: all branches).
 */
export function buildContext(db: DB, userId: string, membershipId: string, branchId: string, ip = ''): Ctx | null {
  const row = db
    .prepare(
      `SELECT u.id AS user_id, u.email, u.display_name, u.is_active AS user_active,
              m.id AS membership_id, m.role, m.is_active AS membership_active, m.org_id
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.id = ? AND u.id = ?`,
    )
    .get(membershipId, userId) as
    | { user_id: string; email: string; display_name: string; user_active: number; membership_id: string; role: Role; membership_active: number; org_id: string }
    | undefined;
  if (!row || !row.user_active || !row.membership_active) return null;

  const assignedBranchIds = assignedBranches(db, row.membership_id, row.role, row.org_id);
  // Work happens only at the branch this server runs (other branches' records here are read-only copies).
  if (!assignedBranchIds.includes(branchId) || !localBranchIds(db).includes(branchId)) return null;

  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(row.org_id) as Organization;
  const branch = db.prepare('SELECT * FROM branches WHERE id = ? AND org_id = ?').get(branchId, row.org_id) as Branch | undefined;
  if (!org || !branch) return null;

  return {
    db,
    user: { id: row.user_id, email: row.email, display_name: row.display_name },
    membership: { id: row.membership_id, role: row.role },
    org,
    branch,
    assignedBranchIds,
    perms: permissionsFor(row.role),
    ip,
  };
}

/**
 * Branches this server is the source of truth for. Once connected to the cloud that is exactly its
 * enrolled branch; before that, every branch in its database (single-branch installations).
 */
export function localBranchIds(db: DB): string[] {
  const own = db.prepare(`SELECT value FROM sync_state WHERE key = 'branch_id'`).pluck().get() as string | undefined;
  return own ? [own] : (db.prepare('SELECT id FROM branches').pluck().all() as string[]);
}

export function assignedBranches(db: DB, membershipId: string, role: Role, orgId: string): string[] {
  if (role === 'owner') {
    return db.prepare('SELECT id FROM branches WHERE org_id = ? ORDER BY name').pluck().all(orgId) as string[];
  }
  return db
    .prepare(
      `SELECT b.id FROM membership_branches mb JOIN branches b ON b.id = mb.branch_id
       WHERE mb.membership_id = ? AND b.org_id = ? ORDER BY b.name`,
    )
    .pluck()
    .all(membershipId, orgId) as string[];
}

// ---------- Audit log (append-only; never store clinical content in details) ----------
export function audit(
  ctx: Pick<Ctx, 'db' | 'ip'> & { org?: { id: string } | null; branch?: { id: string } | null; user?: { id: string } | null },
  action: string,
  entityType = '',
  entityId = '',
  details: Record<string, unknown> = {},
): void {
  ctx.db
    .prepare(
      `INSERT INTO audit_events (id, org_id, branch_id, actor_user_id, action, entity_type, entity_id, at, ip, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newId(), ctx.org?.id ?? null, ctx.branch?.id ?? null, ctx.user?.id ?? null, action, entityType, entityId, nowIso(), ctx.ip ?? '', JSON.stringify(details));
}

/** Map SQLite trigger aborts to friendly application errors. */
export function mapDbError(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  const table: Record<string, AppError> = {
    APPOINTMENT_OVERLAP: new AppError(409, 'APPOINTMENT_OVERLAP', 'That time overlaps another appointment for the same dentist or chair.'),
    INVOICE_IMMUTABLE: new AppError(409, 'INVOICE_IMMUTABLE', 'Issued invoices cannot be changed. Void it or record a correction instead.'),
    APPEND_ONLY: new AppError(409, 'APPEND_ONLY', 'This record is permanent and cannot be changed or deleted.'),
    PAYMENT_EXCEEDS_BALANCE: new AppError(422, 'PAYMENT_EXCEEDS_BALANCE', 'The payment is more than the outstanding balance.'),
    PAYMENT_INVALID_INVOICE: new AppError(422, 'PAYMENT_INVALID_INVOICE', 'Payments can only be recorded against an issued invoice at this branch.'),
    VOID_HAS_PAYMENTS: new AppError(409, 'VOID_HAS_PAYMENTS', 'Reverse all payments on this invoice before voiding it.'),
  };
  for (const [k, err] of Object.entries(table)) if (msg.includes(k)) throw err;
  throw e;
}
