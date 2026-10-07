// Invoices, payments and corrections. Money is integer minor units.
// Rules: issued invoices are frozen; payments and reversals are append-only (DB triggers enforce this);
// a payment's ID is created when the form opens, so resubmitting/retrying never records it twice.
import { z } from 'zod';
import { tx } from '../db/db.js';
import { AppError, conflict, invalid, isUuid, newId, notFound, nowIso, parseMoney } from '../lib/core.js';
import { audit, mapDbError, requirePerm, type Ctx } from './context.js';
import { nextSequence, recordEvent } from './outbox.js';
import { getPatient } from './patients.js';
import { toLocal } from '../lib/time.js';

export const PAYMENT_METHODS = { cash: 'Cash', bank_transfer: 'Bank transfer', card_manual: 'Card (terminal, recorded manually)', e_wallet: 'E-wallet', cheque: 'Cheque' } as const;
export type PaymentMethod = keyof typeof PAYMENT_METHODS;

export interface InvoiceRow {
  id: string; org_id: string; branch_id: string; invoice_no: string | null; patient_id: string;
  dentist_membership_id: string | null; appointment_id: string | null; status: 'draft' | 'issued' | 'void';
  subtotal_minor: number; discount_minor: number; total_minor: number; notes: string;
  issued_at: string | null; issued_by: string | null; voided_at: string | null; voided_by: string | null; void_reason: string | null; created_at: string;
}
export interface LineRow { id: string; service_id: string | null; description: string; quantity: number; unit_price_minor: number; discount_minor: number; line_total_minor: number }
export interface PaymentRow {
  id: string; payment_no: string; invoice_id: string; patient_id: string; amount_minor: number; method: PaymentMethod;
  reference: string; notes: string; received_at: string; received_by: string;
  received_by_name?: string; reversal_reason?: string | null; reversed_at?: string | null; reversed_by_name?: string | null;
}
export interface InvoiceView extends InvoiceRow {
  lines: LineRow[]; payments: PaymentRow[]; paid_minor: number; balance_minor: number;
  patient_name: string; patient_no: string; dentist_name: string | null; issued_by_name: string | null; voided_by_name: string | null;
}

export interface ServiceRow { id: string; code: string; name: string; default_duration_min: number; price_minor: number }
export function listServices(ctx: Ctx): ServiceRow[] {
  return ctx.db.prepare('SELECT id, code, name, default_duration_min, price_minor FROM services WHERE org_id = ? AND is_active = 1 ORDER BY name').all(ctx.org.id) as ServiceRow[];
}

/** Net amount collected on an invoice = payments not reversed. */
export function paidOnInvoice(ctx: Ctx, invoiceId: string): number {
  return ctx.db
    .prepare(`SELECT COALESCE(SUM(p.amount_minor), 0) FROM payments p WHERE p.invoice_id = ?
              AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)`)
    .pluck()
    .get(invoiceId) as number;
}

function loadInvoice(ctx: Ctx, id: string): InvoiceRow {
  if (!isUuid(id)) throw notFound('Invoice');
  // Branch-owned: only visible at its own branch in M1 (cross-branch read-only views come with sync in M2).
  const inv = ctx.db.prepare('SELECT * FROM invoices WHERE id = ? AND org_id = ? AND branch_id = ?').get(id, ctx.org.id, ctx.branch.id) as InvoiceRow | undefined;
  if (!inv) throw notFound('Invoice');
  return inv;
}

export function getInvoice(ctx: Ctx, id: string): InvoiceView {
  requirePerm(ctx, 'billing.view');
  const inv = loadInvoice(ctx, id);
  const names = ctx.db
    .prepare(`SELECT trim(p.first_name || ' ' || p.last_name) AS patient_name, p.patient_no,
                (SELECT u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.id = ?) AS dentist_name,
                (SELECT display_name FROM users WHERE id = ?) AS issued_by_name,
                (SELECT display_name FROM users WHERE id = ?) AS voided_by_name
              FROM patients p WHERE p.id = ?`)
    .get(inv.dentist_membership_id, inv.issued_by, inv.voided_by, inv.patient_id) as {
      patient_name: string; patient_no: string; dentist_name: string | null; issued_by_name: string | null; voided_by_name: string | null;
    };
  const lines = ctx.db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort_order, rowid').all(id) as LineRow[];
  const payments = ctx.db
    .prepare(`SELECT p.*, u.display_name AS received_by_name, r.reason AS reversal_reason, r.reversed_at, ru.display_name AS reversed_by_name
              FROM payments p JOIN users u ON u.id = p.received_by
              LEFT JOIN payment_reversals r ON r.payment_id = p.id LEFT JOIN users ru ON ru.id = r.reversed_by
              WHERE p.invoice_id = ? ORDER BY p.received_at`)
    .all(id) as PaymentRow[];
  const paid = paidOnInvoice(ctx, id);
  return { ...inv, ...names, lines, payments, paid_minor: paid, balance_minor: inv.status === 'issued' ? inv.total_minor - paid : 0 };
}

export function createDraftInvoice(ctx: Ctx, input: { patient_id: string; appointment_id?: string; dentist_id?: string }): string {
  requirePerm(ctx, 'invoice.draft');
  getPatient(ctx, input.patient_id, { audit: false });
  let dentistId: string | null = input.dentist_id && isUuid(input.dentist_id) ? input.dentist_id : null;
  let appointmentId: string | null = null;
  if (input.appointment_id) {
    const a = ctx.db.prepare('SELECT id, dentist_membership_id, patient_id FROM appointments WHERE id = ? AND org_id = ? AND branch_id = ?')
      .get(input.appointment_id, ctx.org.id, ctx.branch.id) as { id: string; dentist_membership_id: string; patient_id: string } | undefined;
    if (!a || a.patient_id !== input.patient_id) throw notFound('Appointment');
    appointmentId = a.id;
    dentistId ??= a.dentist_membership_id;
  }
  if (dentistId && !ctx.db.prepare(`SELECT 1 FROM memberships WHERE id = ? AND org_id = ? AND role = 'dentist'`).get(dentistId, ctx.org.id)) {
    throw invalid('Unknown dentist.');
  }
  const id = newId();
  tx(ctx.db, () => {
    ctx.db.prepare(`INSERT INTO invoices (id, org_id, branch_id, patient_id, dentist_membership_id, appointment_id, status, created_at, created_by)
                    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`)
      .run(id, ctx.org.id, ctx.branch.id, input.patient_id, dentistId, appointmentId, nowIso(), ctx.user.id);
    audit(ctx, 'invoice.draft_create', 'invoice', id);
    // Drafts are local working documents; they are synced when issued.
  });
  return id;
}

function loadDraft(ctx: Ctx, id: string): InvoiceRow {
  requirePerm(ctx, 'invoice.draft');
  const inv = loadInvoice(ctx, id);
  if (inv.status !== 'draft') throw conflict('INVOICE_IMMUTABLE', 'This invoice has been issued and can no longer be edited.');
  return inv;
}

function recalc(ctx: Ctx, invoiceId: string): void {
  const sub = ctx.db.prepare('SELECT COALESCE(SUM(line_total_minor), 0) FROM invoice_lines WHERE invoice_id = ?').pluck().get(invoiceId) as number;
  const inv = ctx.db.prepare('SELECT discount_minor FROM invoices WHERE id = ?').get(invoiceId) as { discount_minor: number };
  const discount = Math.min(inv.discount_minor, sub);
  ctx.db.prepare('UPDATE invoices SET subtotal_minor = ?, discount_minor = ?, total_minor = ? WHERE id = ?').run(sub, discount, sub - discount, invoiceId);
}

const lineSchema = z.object({
  service_id: z.string().default(''),
  description: z.string().trim().max(200).default(''),
  quantity: z.coerce.number().int('Whole numbers only').min(1, 'At least 1').max(1000),
  unit_price: z.string().default(''),
  discount: z.string().default(''),
});

export function addLine(ctx: Ctx, invoiceId: string, raw: unknown): void {
  loadDraft(ctx, invoiceId);
  const r = lineSchema.safeParse(raw);
  if (!r.success) throw invalid('Please correct the line item.', Object.fromEntries(r.error.issues.map((i) => [String(i.path[0]), i.message])));
  const input = r.data;
  const cur = ctx.org.currency;
  let description = input.description;
  let unitPrice: number | null = input.unit_price.trim() ? parseMoney(input.unit_price, cur) : null;
  let serviceId: string | null = null;
  if (input.service_id) {
    const svc = ctx.db.prepare('SELECT * FROM services WHERE id = ? AND org_id = ? AND is_active = 1').get(input.service_id, ctx.org.id) as ServiceRow | undefined;
    if (!svc) throw invalid('Unknown procedure.', { service_id: 'Unknown procedure' });
    serviceId = svc.id;
    description ||= svc.name;
    if (!input.unit_price.trim()) unitPrice = svc.price_minor;
  }
  if (!description) throw invalid('Enter a description or choose a procedure.', { description: 'Required' });
  if (unitPrice === null) throw invalid('Enter a valid price, e.g. 1500.00', { unit_price: 'Invalid amount' });
  const discount = input.discount.trim() ? parseMoney(input.discount, cur) : 0;
  if (discount === null) throw invalid('Enter a valid discount amount.', { discount: 'Invalid amount' });
  const gross = input.quantity * unitPrice;
  if (discount > gross) throw invalid('Discount cannot exceed the line amount.', { discount: 'Too large' });
  tx(ctx.db, () => {
    const order = ctx.db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 FROM invoice_lines WHERE invoice_id = ?').pluck().get(invoiceId) as number;
    ctx.db.prepare(`INSERT INTO invoice_lines (id, invoice_id, service_id, description, quantity, unit_price_minor, discount_minor, line_total_minor, sort_order)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(newId(), invoiceId, serviceId, description, input.quantity, unitPrice, discount, gross - discount, order);
    recalc(ctx, invoiceId);
  });
}

export function removeLine(ctx: Ctx, invoiceId: string, lineId: string): void {
  loadDraft(ctx, invoiceId);
  tx(ctx.db, () => {
    ctx.db.prepare('DELETE FROM invoice_lines WHERE id = ? AND invoice_id = ?').run(lineId, invoiceId);
    recalc(ctx, invoiceId);
  });
}

export function setInvoiceDiscount(ctx: Ctx, invoiceId: string, discountInput: string): void {
  const inv = loadDraft(ctx, invoiceId);
  const d = discountInput.trim() ? parseMoney(discountInput, ctx.org.currency) : 0;
  if (d === null) throw invalid('Enter a valid discount amount.', { invoice_discount: 'Invalid amount' });
  if (d > inv.subtotal_minor) throw invalid('Discount cannot exceed the subtotal.', { invoice_discount: 'Too large' });
  // One statement, so the total = subtotal − discount check holds at every step.
  ctx.db.prepare(`UPDATE invoices SET discount_minor = ?, total_minor = subtotal_minor - ? WHERE id = ? AND status = 'draft'`).run(d, d, invoiceId);
}

export function deleteDraft(ctx: Ctx, invoiceId: string): void {
  loadDraft(ctx, invoiceId);
  tx(ctx.db, () => {
    ctx.db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(invoiceId);
    ctx.db.prepare(`DELETE FROM invoices WHERE id = ? AND status = 'draft'`).run(invoiceId);
    audit(ctx, 'invoice.draft_delete', 'invoice', invoiceId);
  });
}

export function issueInvoice(ctx: Ctx, invoiceId: string): string {
  requirePerm(ctx, 'invoice.issue');
  let invoiceNo = '';
  tx(ctx.db, () => {
    const inv = loadDraft(ctx, invoiceId);
    const lines = ctx.db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort_order').all(invoiceId) as LineRow[];
    if (!lines.length) throw invalid('Add at least one line item before issuing.');
    const year = toLocal(nowIso(), ctx.branch.timezone).year;
    const n = nextSequence(ctx.db, ctx.branch.id, `invoice:${year}`);
    invoiceNo = `INV-${ctx.branch.code}-${year}-${String(n).padStart(5, '0')}`;
    const now = nowIso();
    ctx.db.prepare(`UPDATE invoices SET status = 'issued', invoice_no = ?, issued_at = ?, issued_by = ? WHERE id = ? AND status = 'draft'`)
      .run(invoiceNo, now, ctx.user.id, invoiceId);
    recordEvent(ctx, {
      entityType: 'invoice', entityId: invoiceId, op: 'issued', entityVersion: 1,
      payload: { invoice_no: invoiceNo, patient_id: inv.patient_id, dentist_membership_id: inv.dentist_membership_id, appointment_id: inv.appointment_id,
        subtotal_minor: inv.subtotal_minor, discount_minor: inv.discount_minor, total_minor: inv.total_minor, currency: ctx.org.currency, issued_at: now,
        lines: lines.map((l) => ({ id: l.id, service_id: l.service_id, description: l.description, quantity: l.quantity, unit_price_minor: l.unit_price_minor, discount_minor: l.discount_minor, line_total_minor: l.line_total_minor })) },
    });
    audit(ctx, 'invoice.issue', 'invoice', invoiceId, { invoice_no: invoiceNo, total_minor: inv.total_minor });
  });
  return invoiceNo;
}

export function voidInvoice(ctx: Ctx, invoiceId: string, reason: string): void {
  requirePerm(ctx, 'invoice.void');
  if (reason.trim().length < 5) throw invalid('Please give a reason (at least 5 characters).', { reason: 'Required' });
  try {
    tx(ctx.db, () => {
      const inv = loadInvoice(ctx, invoiceId);
      if (inv.status !== 'issued') throw conflict('INVALID_STATE', 'Only issued invoices can be voided.');
      if (paidOnInvoice(ctx, invoiceId) > 0) throw conflict('VOID_HAS_PAYMENTS', 'Reverse all payments on this invoice before voiding it.');
      const now = nowIso();
      ctx.db.prepare(`UPDATE invoices SET status = 'void', voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?`).run(now, ctx.user.id, reason.trim(), invoiceId);
      recordEvent(ctx, { entityType: 'invoice', entityId: invoiceId, op: 'voided', entityVersion: 2, baseVersion: 1, payload: { reason: reason.trim(), voided_at: now } });
      audit(ctx, 'invoice.void', 'invoice', invoiceId);
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapDbError(e);
  }
}

export interface PaymentInput { payment_id: string; amount: string; method: string; reference?: string; notes?: string }

/**
 * Record a payment. Idempotent on payment_id: a retry with the same ID and same details returns the
 * existing payment instead of creating a second one.
 */
export function recordPayment(ctx: Ctx, invoiceId: string, input: PaymentInput): { paymentId: string; paymentNo: string; duplicate: boolean } {
  requirePerm(ctx, 'payment.record');
  if (!isUuid(input.payment_id)) throw invalid('This payment form has expired. Please reload the page.');
  const amount = parseMoney(input.amount, ctx.org.currency);
  if (amount === null || amount <= 0) throw invalid('Enter an amount greater than zero, e.g. 500.00', { amount: 'Invalid amount' });
  if (!(input.method in PAYMENT_METHODS)) throw invalid('Choose a payment method.', { method: 'Required' });
  const reference = (input.reference ?? '').trim().slice(0, 100);
  const notes = (input.notes ?? '').trim().slice(0, 300);
  if (input.method !== 'cash' && !reference) throw invalid('Enter the transaction/reference number for non-cash payments.', { reference: 'Required for non-cash payments' });

  try {
    return tx(ctx.db, () => {
      const existing = ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(input.payment_id) as (PaymentRow & { org_id: string }) | undefined;
      if (existing) {
        if (existing.org_id !== ctx.org.id || existing.invoice_id !== invoiceId || existing.amount_minor !== amount) {
          throw conflict('PAYMENT_ID_REUSED', 'This payment form was already used for a different payment. Reload the page.');
        }
        return { paymentId: existing.id, paymentNo: existing.payment_no, duplicate: true };
      }
      const inv = loadInvoice(ctx, invoiceId);
      if (inv.status !== 'issued') throw conflict('INVALID_STATE', 'Payments can only be recorded against an issued invoice.');
      const balance = inv.total_minor - paidOnInvoice(ctx, invoiceId);
      if (amount > balance) throw invalid('The payment is more than the outstanding balance.', { amount: 'More than balance' });
      const year = toLocal(nowIso(), ctx.branch.timezone).year;
      const paymentNo = `PAY-${ctx.branch.code}-${year}-${String(nextSequence(ctx.db, ctx.branch.id, `payment:${year}`)).padStart(5, '0')}`;
      const now = nowIso();
      ctx.db.prepare(`INSERT INTO payments (id, org_id, branch_id, payment_no, invoice_id, patient_id, amount_minor, method, reference, notes, received_at, received_by)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.payment_id, ctx.org.id, ctx.branch.id, paymentNo, invoiceId, inv.patient_id, amount, input.method, reference, notes, now, ctx.user.id);
      recordEvent(ctx, { entityType: 'payment', entityId: input.payment_id, op: 'recorded', entityVersion: 1,
        payload: { payment_no: paymentNo, invoice_id: invoiceId, patient_id: inv.patient_id, amount_minor: amount, currency: ctx.org.currency, method: input.method, reference, received_at: now } });
      audit(ctx, 'payment.record', 'payment', input.payment_id, { invoice_id: invoiceId, amount_minor: amount, method: input.method });
      return { paymentId: input.payment_id, paymentNo, duplicate: false };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapDbError(e);
  }
}

export function reversePayment(ctx: Ctx, paymentId: string, reason: string): void {
  requirePerm(ctx, 'payment.reverse');
  if (reason.trim().length < 5) throw invalid('Please give a reason (at least 5 characters).', { reason: 'Required' });
  if (!isUuid(paymentId)) throw notFound('Payment');
  try {
    tx(ctx.db, () => {
      const p = ctx.db.prepare('SELECT * FROM payments WHERE id = ? AND org_id = ? AND branch_id = ?').get(paymentId, ctx.org.id, ctx.branch.id) as PaymentRow | undefined;
      if (!p) throw notFound('Payment');
      if (ctx.db.prepare('SELECT 1 FROM payment_reversals WHERE payment_id = ?').get(paymentId)) throw conflict('ALREADY_REVERSED', 'This payment has already been reversed.');
      const id = newId();
      const now = nowIso();
      ctx.db.prepare('INSERT INTO payment_reversals (id, org_id, branch_id, payment_id, reason, reversed_at, reversed_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, ctx.org.id, ctx.branch.id, paymentId, reason.trim(), now, ctx.user.id);
      recordEvent(ctx, { entityType: 'payment', entityId: paymentId, op: 'reversed', entityVersion: 2, baseVersion: 1, payload: { reversal_id: id, reason: reason.trim(), reversed_at: now, amount_minor: p.amount_minor } });
      audit(ctx, 'payment.reverse', 'payment', paymentId, { amount_minor: p.amount_minor });
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapDbError(e);
  }
}

export function getPayment(ctx: Ctx, paymentId: string): PaymentRow & { invoice_no: string; patient_name: string; patient_no: string } {
  requirePerm(ctx, 'billing.view');
  if (!isUuid(paymentId)) throw notFound('Payment');
  const p = ctx.db
    .prepare(`SELECT p.*, i.invoice_no, trim(pt.first_name || ' ' || pt.last_name) AS patient_name, pt.patient_no, u.display_name AS received_by_name,
                r.reason AS reversal_reason, r.reversed_at
              FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN patients pt ON pt.id = p.patient_id JOIN users u ON u.id = p.received_by
              LEFT JOIN payment_reversals r ON r.payment_id = p.id
              WHERE p.id = ? AND p.org_id = ? AND p.branch_id = ?`)
    .get(paymentId, ctx.org.id, ctx.branch.id) as (PaymentRow & { invoice_no: string; patient_name: string; patient_no: string }) | undefined;
  if (!p) throw notFound('Payment');
  return p;
}

/** Patient account at the current branch: invoices with charges, collections, balances. */
export function patientAccount(ctx: Ctx, patientId: string) {
  requirePerm(ctx, 'billing.view');
  const invoices = ctx.db
    .prepare(`SELECT i.*, (SELECT COALESCE(SUM(p.amount_minor),0) FROM payments p WHERE p.invoice_id = i.id
                AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)) AS paid_minor
              FROM invoices i WHERE i.patient_id = ? AND i.org_id = ? AND i.branch_id = ? ORDER BY i.created_at DESC`)
    .all(patientId, ctx.org.id, ctx.branch.id) as (InvoiceRow & { paid_minor: number })[];
  const issued = invoices.filter((i) => i.status === 'issued');
  return {
    invoices: invoices.map((i) => ({ ...i, balance_minor: i.status === 'issued' ? i.total_minor - i.paid_minor : 0 })),
    charges_minor: issued.reduce((s, i) => s + i.total_minor, 0),
    collected_minor: issued.reduce((s, i) => s + i.paid_minor, 0),
    outstanding_minor: issued.reduce((s, i) => s + i.total_minor - i.paid_minor, 0),
  };
}
