// Branch reports. Metric names are deliberately precise:
//   Payments received  = money recorded as received on that local day (before reversals)
//   Reversals recorded = reversals entered on that day (they may reverse payments from earlier days)
//   Net collections    = payments received − reversals recorded, for that day
//   Charges issued     = totals of invoices issued that day (drafts excluded)
//   Outstanding        = issued, non-void invoices minus net payments, as of now
// None of these is accounting profit or a tax figure.
import { dayRangeUtc } from '../lib/time.js';
import { nowIso } from '../lib/core.js';
import { requirePerm, type Ctx } from './context.js';
import type { PaymentMethod } from './billing.js';

export interface DailyCollections {
  date: string;
  payments: { id: string; payment_no: string; received_at: string; amount_minor: number; method: PaymentMethod; reference: string;
    patient_name: string; patient_no: string; invoice_no: string; invoice_id: string; received_by: string; dentist: string | null; reversed: number }[];
  reversals: { payment_no: string; amount_minor: number; reversed_at: string; reason: string; reversed_by: string; original_received_at: string }[];
  byMethod: { method: PaymentMethod; count: number; amount_minor: number }[];
  byDentist: { dentist: string; amount_minor: number }[];
  received_minor: number;
  reversed_minor: number;
  net_minor: number;
  charges_issued_minor: number;
  invoices_issued: number;
  outstanding_minor: number;
  generated_at: string;
}

export function dailyCollections(ctx: Ctx, date: string): DailyCollections {
  requirePerm(ctx, 'report.collections.view');
  const [from, to] = dayRangeUtc(date, ctx.branch.timezone);
  const db = ctx.db;
  const b = ctx.branch.id;
  const payments = db
    .prepare(`SELECT p.id, p.payment_no, p.received_at, p.amount_minor, p.method, p.reference, trim(pt.first_name || ' ' || pt.last_name) AS patient_name,
                pt.patient_no, i.invoice_no, i.id AS invoice_id, u.display_name AS received_by, du.display_name AS dentist,
                EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id) AS reversed
              FROM payments p JOIN patients pt ON pt.id = p.patient_id JOIN invoices i ON i.id = p.invoice_id JOIN users u ON u.id = p.received_by
              LEFT JOIN memberships dm ON dm.id = i.dentist_membership_id LEFT JOIN users du ON du.id = dm.user_id
              WHERE p.branch_id = ? AND p.org_id = ? AND p.received_at >= ? AND p.received_at < ? ORDER BY p.received_at`)
    .all(b, ctx.org.id, from, to) as DailyCollections['payments'];
  const reversals = db
    .prepare(`SELECT p.payment_no, p.amount_minor, r.reversed_at, r.reason, u.display_name AS reversed_by, p.received_at AS original_received_at
              FROM payment_reversals r JOIN payments p ON p.id = r.payment_id JOIN users u ON u.id = r.reversed_by
              WHERE r.branch_id = ? AND r.org_id = ? AND r.reversed_at >= ? AND r.reversed_at < ? ORDER BY r.reversed_at`)
    .all(b, ctx.org.id, from, to) as DailyCollections['reversals'];

  const byMethodMap = new Map<PaymentMethod, { count: number; amount_minor: number }>();
  const byDentistMap = new Map<string, number>();
  for (const p of payments) {
    const m = byMethodMap.get(p.method) ?? { count: 0, amount_minor: 0 };
    m.count++;
    m.amount_minor += p.amount_minor;
    byMethodMap.set(p.method, m);
    const d = p.dentist ?? 'Not assigned';
    byDentistMap.set(d, (byDentistMap.get(d) ?? 0) + p.amount_minor);
  }
  const received = payments.reduce((s, p) => s + p.amount_minor, 0);
  const reversed = reversals.reduce((s, r) => s + r.amount_minor, 0);
  const charges = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_minor), 0) AS total FROM invoices
              WHERE branch_id = ? AND org_id = ? AND issued_at >= ? AND issued_at < ?`)
    .get(b, ctx.org.id, from, to) as { n: number; total: number };
  return {
    date,
    payments,
    reversals,
    byMethod: [...byMethodMap].map(([method, v]) => ({ method, ...v })),
    byDentist: [...byDentistMap].map(([dentist, amount_minor]) => ({ dentist, amount_minor })).sort((a, b2) => b2.amount_minor - a.amount_minor),
    received_minor: received,
    reversed_minor: reversed,
    net_minor: received - reversed,
    charges_issued_minor: charges.total,
    invoices_issued: charges.n,
    outstanding_minor: branchOutstanding(ctx),
    generated_at: nowIso(),
  };
}

export function branchOutstanding(ctx: Ctx): number {
  return ctx.db
    .prepare(`SELECT COALESCE(SUM(i.total_minor), 0) - COALESCE((SELECT SUM(p.amount_minor) FROM payments p JOIN invoices i2 ON i2.id = p.invoice_id
                WHERE i2.branch_id = @b AND i2.status = 'issued' AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)), 0)
              FROM invoices i WHERE i.branch_id = @b AND i.org_id = @o AND i.status = 'issued'`)
    .pluck()
    .get({ b: ctx.branch.id, o: ctx.org.id }) as number;
}
