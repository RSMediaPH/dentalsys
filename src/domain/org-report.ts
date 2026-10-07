// Organization-wide consolidated report, computed on this branch server from its own data plus the
// read-only copies of other branches received through the cloud. Every branch row says how fresh it is,
// and the report says plainly when it may be incomplete.
import { DateTime } from 'luxon';
import { clock, isUuid } from '../lib/core.js';
import { isValidDate } from '../lib/time.js';
import { requirePerm, type Ctx } from './context.js';
import { syncStatus } from './outbox.js';

export const STALE_MINUTES = Number(process.env.SYNC_STALE_MINUTES ?? 60);

export type Freshness = 'live' | 'current' | 'stale' | 'no_data';

export interface BranchRow {
  branch_id: string; code: string; name: string;
  freshness: Freshness; freshness_note: string; data_as_of: string | null;
  received_minor: number; reversed_minor: number; net_minor: number; charges_minor: number; outstanding_minor: number;
  appointments: number; completed: number; no_shows: number; cancelled: number;
}

export interface OrgReport {
  from: string; to: string; tz: string; generated_at: string;
  rows: BranchRow[];
  totals: Omit<BranchRow, 'branch_id' | 'code' | 'name' | 'freshness' | 'freshness_note' | 'data_as_of'>;
  incomplete: boolean; incomplete_reasons: string[];
  cloud: ReturnType<typeof syncStatus>;
}

const minutesAgo = (iso: string | null) => (iso ? (clock.now().getTime() - Date.parse(iso)) / 60_000 : Infinity);

export function branchFreshness(ctx: Ctx, branchId: string): { freshness: Freshness; note: string; asOf: string | null } {
  if (branchId === ctx.branch.id) return { freshness: 'live', note: 'This branch (live)', asOf: clock.now().toISOString() };
  const cloud = syncStatus(ctx.db);
  if (!cloud.cloudConfigured) return { freshness: 'no_data', note: 'Cloud sync not set up — no data from this branch', asOf: null };
  const rs = ctx.db.prepare('SELECT last_event_at, last_seen_at FROM remote_branch_status WHERE branch_id = ?').get(branchId) as { last_event_at: string | null; last_seen_at: string | null } | undefined;
  if (!rs?.last_seen_at) return { freshness: 'no_data', note: 'Has never synchronized', asOf: null };
  // Data from that branch is only as fresh as both its last contact with the cloud and our last download.
  const ourDownload = cloud.lastSuccessAt;
  const asOf = ourDownload && rs.last_seen_at < ourDownload ? rs.last_seen_at : ourDownload;
  const stale = minutesAgo(rs.last_seen_at) > STALE_MINUTES || minutesAgo(ourDownload) > STALE_MINUTES;
  return { freshness: stale ? 'stale' : 'current', note: stale ? `Not updated for over ${STALE_MINUTES} minutes` : 'Up to date', asOf };
}

export function orgReport(ctx: Ctx, from: string, to: string): OrgReport {
  requirePerm(ctx, 'report.org.view');
  const tz = ctx.org.default_timezone;
  const today = DateTime.fromJSDate(clock.now()).setZone(tz).toISODate()!;
  const f = isValidDate(from) ? from : today;
  const t = isValidDate(to) && to >= f ? to : f;
  const start = DateTime.fromISO(f, { zone: tz }).startOf('day').toUTC().toISO()!;
  const end = DateTime.fromISO(t, { zone: tz }).plus({ days: 1 }).startOf('day').toUTC().toISO()!;
  const db = ctx.db;
  const branches = db.prepare('SELECT id, code, name FROM branches WHERE org_id = ? ORDER BY code').all(ctx.org.id) as { id: string; code: string; name: string }[];
  const one = (sql: string, ...p: unknown[]) => (db.prepare(sql).pluck().get(...p) as number) ?? 0;
  const rows: BranchRow[] = branches.map((b) => {
    const fr = branchFreshness(ctx, b.id);
    const received = one(`SELECT COALESCE(SUM(amount_minor),0) FROM payments WHERE branch_id = ? AND received_at >= ? AND received_at < ?`, b.id, start, end);
    const reversed = one(`SELECT COALESCE(SUM(p.amount_minor),0) FROM payment_reversals r JOIN payments p ON p.id = r.payment_id WHERE r.branch_id = ? AND r.reversed_at >= ? AND r.reversed_at < ?`, b.id, start, end);
    const charges = one(`SELECT COALESCE(SUM(total_minor),0) FROM invoices WHERE branch_id = ? AND issued_at >= ? AND issued_at < ?`, b.id, start, end);
    const outstanding = one(`SELECT COALESCE(SUM(i.total_minor - (SELECT COALESCE(SUM(p.amount_minor),0) FROM payments p WHERE p.invoice_id = i.id
                               AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id))),0)
                             FROM invoices i WHERE i.branch_id = ? AND i.status = 'issued'`, b.id);
    const appt = db.prepare(`SELECT COUNT(*) AS n, SUM(status = 'completed') AS completed, SUM(status = 'no_show') AS no_shows, SUM(status = 'cancelled') AS cancelled
                             FROM appointments WHERE branch_id = ? AND start_at >= ? AND start_at < ?`).get(b.id, start, end) as { n: number; completed: number | null; no_shows: number | null; cancelled: number | null };
    return {
      branch_id: b.id, code: b.code, name: b.name, freshness: fr.freshness, freshness_note: fr.note, data_as_of: fr.asOf,
      received_minor: received, reversed_minor: reversed, net_minor: received - reversed, charges_minor: charges, outstanding_minor: outstanding,
      appointments: appt.n, completed: appt.completed ?? 0, no_shows: appt.no_shows ?? 0, cancelled: appt.cancelled ?? 0,
    };
  });
  const sum = (k: keyof BranchRow) => rows.reduce((s, r) => s + (r[k] as number), 0);
  const reasons = rows.filter((r) => r.freshness === 'stale' || r.freshness === 'no_data').map((r) => `${r.name}: ${r.freshness_note.toLowerCase()}`);
  return {
    from: f, to: t, tz, generated_at: clock.now().toISOString(), rows,
    totals: {
      received_minor: sum('received_minor'), reversed_minor: sum('reversed_minor'), net_minor: sum('net_minor'), charges_minor: sum('charges_minor'),
      outstanding_minor: sum('outstanding_minor'), appointments: sum('appointments'), completed: sum('completed'), no_shows: sum('no_shows'), cancelled: sum('cancelled'),
    },
    incomplete: reasons.length > 0,
    incomplete_reasons: reasons,
    cloud: syncStatus(db),
  };
}

/** Outstanding balance for a patient at OTHER branches, from synchronized copies. */
export function patientBalanceElsewhere(ctx: Ctx, patientId: string): { outstanding_minor: number; branches: { name: string; outstanding_minor: number; freshness: Freshness; asOf: string | null }[] } {
  if (!isUuid(patientId)) return { outstanding_minor: 0, branches: [] };
  const rows = ctx.db.prepare(`SELECT i.branch_id, b.name, SUM(i.total_minor - (SELECT COALESCE(SUM(p.amount_minor),0) FROM payments p WHERE p.invoice_id = i.id
                                 AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id))) AS outstanding
                               FROM invoices i JOIN branches b ON b.id = i.branch_id
                               WHERE i.patient_id = ? AND i.org_id = ? AND i.branch_id <> ? AND i.status = 'issued' GROUP BY i.branch_id`)
    .all(patientId, ctx.org.id, ctx.branch.id) as { branch_id: string; name: string; outstanding: number }[];
  const branches = rows.filter((r) => r.outstanding > 0).map((r) => {
    const fr = branchFreshness(ctx, r.branch_id);
    return { name: r.name, outstanding_minor: r.outstanding, freshness: fr.freshness, asOf: fr.asOf };
  });
  return { outstanding_minor: branches.reduce((s, b) => s + b.outstanding_minor, 0), branches };
}
