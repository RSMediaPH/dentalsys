// Invoices, payments, reversals and printable payment acknowledgements.
import type { FastifyInstance } from 'fastify';
import {
  addLine, createDraftInvoice, deleteDraft, getInvoice, getPayment, issueInvoice, listServices, PAYMENT_METHODS, recordPayment,
  removeLine, reversePayment, setInvoiceDiscount, voidInvoice, type InvoiceView,
} from '../../domain/billing.js';
import { can, requirePerm, type Ctx } from '../../domain/context.js';
import { AppError, html, minorToInput, newId } from '../../lib/core.js';
import { fmtDateTime } from '../../lib/time.js';
import { csrfInput, emptyState, field, money, page, select, statusBadge } from '../ui.js';
import { flashFromQuery, formOf, queryOf, requireAuth, sendPage, type Deps, type Form } from '../app.js';

type Flash = { kind: 'ok' | 'error' | 'warn'; text: string } | null;

function invoicePage(ctx: Ctx, csrf: string, inv: InvoiceView, flash: Flash, errors: Record<string, string> = {}, values: Form = {}) {
  const tz = ctx.branch.timezone;
  const draft = inv.status === 'draft';
  const services = listServices(ctx);
  return page({
    title: inv.invoice_no ?? 'Draft invoice', ctx, csrf, active: 'billing', flash,
    body: html`<div class="page-head"><div><h1>${inv.invoice_no ?? 'Draft invoice'} ${statusBadge(inv.status, inv.status)}</h1>
        <p class="muted"><a href="/patients/${inv.patient_id}">${inv.patient_name}</a> · ${inv.patient_no}${inv.dentist_name ? ` · ${inv.dentist_name}` : ''}
        ${inv.issued_at ? ` · Issued ${fmtDateTime(inv.issued_at, tz)} by ${inv.issued_by_name}` : ''}</p></div></div>
      ${inv.status === 'void' ? html`<div class="flash warn">Voided ${fmtDateTime(inv.voided_at, tz)} by ${inv.voided_by_name}: ${inv.void_reason}</div>` : ''}
      ${inv.status === 'issued' ? html`<div class="kpis">
        <div class="kpi"><span>Invoice total (charges)</span><strong>${money(ctx, inv.total_minor)}</strong></div>
        <div class="kpi"><span>Collected (net of reversals)</span><strong>${money(ctx, inv.paid_minor)}</strong></div>
        <div class="kpi ${inv.balance_minor > 0 ? 'due' : 'paid'}"><span>Outstanding balance</span><strong data-testid="balance">${money(ctx, inv.balance_minor)}</strong></div></div>` : ''}

      <h2>Items</h2>
      ${inv.lines.length ? html`<table class="table"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Discount</th><th class="num">Amount</th>${draft ? html`<th></th>` : ''}</tr></thead>
        <tbody>${inv.lines.map((l) => html`<tr><td>${l.description}</td><td class="num">${l.quantity}</td><td class="num">${money(ctx, l.unit_price_minor)}</td>
          <td class="num">${l.discount_minor ? money(ctx, l.discount_minor) : '—'}</td><td class="num">${money(ctx, l.line_total_minor)}</td>
          ${draft ? html`<td><form method="post" action="/invoices/${inv.id}/lines/${l.id}/delete" class="inline">${csrfInput(csrf)}<button class="link danger">Remove</button></form></td>` : ''}</tr>`)}</tbody>
        <tfoot><tr><td colspan="4">Subtotal</td><td class="num">${money(ctx, inv.subtotal_minor)}</td>${draft ? html`<td></td>` : ''}</tr>
          <tr><td colspan="4">Invoice discount</td><td class="num">${inv.discount_minor ? `− ${money(ctx, inv.discount_minor)}` : '—'}</td>${draft ? html`<td></td>` : ''}</tr>
          <tr class="total"><td colspan="4">Total</td><td class="num">${money(ctx, inv.total_minor)}</td>${draft ? html`<td></td>` : ''}</tr></tfoot></table>`
        : emptyState('No items yet', 'Add a procedure from the catalog or a custom item below.')}

      ${draft ? html`
        <form method="post" action="/invoices/${inv.id}/lines" class="stack card" novalidate>${csrfInput(csrf)}<h3>Add item</h3>
          <div class="grid3">
            ${select('Procedure', 'service_id', services.map((s) => ({ value: s.id, label: `${s.code} · ${s.name} — ${money(ctx, s.price_minor)}` })), values.service_id ?? '', { placeholder: '— Custom item —', errors })}
            ${field('Description (custom item)', 'description', values.description, { errors, hint: 'Leave blank to use the procedure name' })}
            ${field('Quantity', 'quantity', values.quantity ?? '1', { type: 'number', required: true, errors, attrs: html`min="1" step="1"` })}
            ${field(`Unit price (${ctx.org.currency})`, 'unit_price', values.unit_price, { errors, hint: 'Leave blank to use the catalog price', attrs: html`inputmode="decimal"` })}
            ${field(`Line discount (${ctx.org.currency})`, 'discount', values.discount, { errors, attrs: html`inputmode="decimal"` })}
          </div><div class="actions"><button>Add item</button></div></form>
        <form method="post" action="/invoices/${inv.id}/discount" class="inline-form">${csrfInput(csrf)}
          ${field(`Invoice discount (${ctx.org.currency})`, 'invoice_discount', values.invoice_discount ?? (inv.discount_minor ? minorToInput(inv.discount_minor, ctx.org.currency) : ''), { errors, attrs: html`inputmode="decimal"` })}
          <button>Apply discount</button></form>
        <div class="actions">
          ${can(ctx, 'invoice.issue') ? html`<form method="post" action="/invoices/${inv.id}/issue" class="inline">${csrfInput(csrf)}
            <button class="primary" ${inv.lines.length ? '' : html`disabled`} data-confirm="Issue this invoice for ${money(ctx, inv.total_minor)}? Issued invoices cannot be edited.">Issue invoice</button></form>`
            : html`<p class="hint">A receptionist or manager will issue this invoice.</p>`}
          <form method="post" action="/invoices/${inv.id}/delete" class="inline">${csrfInput(csrf)}<button class="link danger" data-confirm="Delete this draft?">Delete draft</button></form>
        </div>` : ''}

      ${inv.status !== 'draft' ? html`<h2>Payments</h2>
        ${inv.payments.length ? html`<table class="table"><thead><tr><th>Payment no.</th><th>Received</th><th>Method</th><th>Reference</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>${inv.payments.map((p) => html`<tr class="${p.reversed_at ? 'reversed' : ''}"><td>${p.payment_no}</td><td>${fmtDateTime(p.received_at, tz)}<br><span class="muted">${p.received_by_name}</span></td>
            <td>${PAYMENT_METHODS[p.method]}</td><td>${p.reference || '—'}</td><td class="num">${money(ctx, p.amount_minor)}</td>
            <td>${p.reversed_at ? html`<span class="badge st-cancelled">Reversed</span><br><span class="muted">${fmtDateTime(p.reversed_at, tz)} · ${p.reversed_by_name}: ${p.reversal_reason}</span>` : html`<span class="badge st-completed">Recorded</span>`}</td>
            <td><a href="/payments/${p.id}/print" target="_blank" rel="noopener">Print acknowledgement</a>
              ${!p.reversed_at && can(ctx, 'payment.reverse') ? html`<details><summary>Reverse</summary><form method="post" action="/payments/${p.id}/reverse" class="stack">${csrfInput(csrf)}
                ${field('Reason', 'reason', '', { required: true, hint: 'e.g. entered on the wrong invoice' })}<button class="danger" data-confirm="Reverse ${p.payment_no} (${money(ctx, p.amount_minor)})? This is recorded permanently.">Reverse payment</button></form></details>` : ''}</td></tr>`)}</tbody></table>`
          : html`<p class="muted">No payments recorded yet.</p>`}
        ${inv.status === 'issued' && inv.balance_minor > 0 && can(ctx, 'payment.record') ? html`
          <form method="post" action="/invoices/${inv.id}/payments" class="stack card" novalidate>${csrfInput(csrf)}<h3>Record payment</h3>
            <input type="hidden" name="payment_id" value="${values.payment_id ?? newId()}">
            <div class="grid3">
              ${field(`Amount received (${ctx.org.currency})`, 'amount', values.amount ?? minorToInput(inv.balance_minor, ctx.org.currency), { required: true, errors, hint: `Outstanding: ${money(ctx, inv.balance_minor)}. Partial payments are allowed.`, attrs: html`inputmode="decimal"` })}
              ${select('Method', 'method', Object.entries(PAYMENT_METHODS).map(([value, label]) => ({ value, label })), values.method ?? 'cash', { required: true, errors })}
              ${field('Reference no.', 'reference', values.reference, { errors, hint: 'Required for non-cash payments' })}
            </div>
            <div class="actions"><button class="primary" type="submit">Record payment</button></div>
            <p class="hint">Card payments are processed on your own terminal and only recorded here.</p></form>` : ''}
        ${inv.status === 'issued' && can(ctx, 'invoice.void') ? html`<details><summary>Void invoice</summary>
          <form method="post" action="/invoices/${inv.id}/void" class="stack narrow">${csrfInput(csrf)}
          <p class="hint">Only possible when all payments have been reversed. The invoice stays on record marked void.</p>
          ${field('Reason', 'reason', '', { required: true })}<button class="danger" data-confirm="Void this invoice?">Void invoice</button></form></details>` : ''}` : ''}`,
  });
}

export function registerBillingRoutes(app: FastifyInstance, _deps: Deps): void {
  app.get('/invoices', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    const { ctx } = a;
    requirePerm(ctx, 'billing.view');
    const filter = queryOf(req).filter === 'all' ? 'all' : 'outstanding';
    const rows = ctx.db
      .prepare(`SELECT i.*, trim(p.first_name || ' ' || p.last_name) AS patient_name, p.patient_no,
                  i.total_minor - (SELECT COALESCE(SUM(pm.amount_minor),0) FROM payments pm WHERE pm.invoice_id = i.id
                    AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = pm.id)) AS balance_minor
                FROM invoices i JOIN patients p ON p.id = i.patient_id WHERE i.branch_id = ? AND i.org_id = ?
                ${filter === 'outstanding' ? `AND (i.status = 'draft' OR (i.status = 'issued' AND i.total_minor > (SELECT COALESCE(SUM(pm.amount_minor),0) FROM payments pm WHERE pm.invoice_id = i.id AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = pm.id))))` : ''}
                ORDER BY i.created_at DESC LIMIT 200`)
      .all(ctx.branch.id, ctx.org.id) as (InvoiceView & { balance_minor: number })[];
    return sendPage(reply, page({ title: 'Billing', ctx, csrf: a.csrf, active: 'billing', flash: flashFromQuery(req),
      body: html`<div class="page-head"><h1>Billing</h1></div>
        <div class="toolbar"><span class="seg"><a href="/invoices" ${filter === 'outstanding' ? html`aria-current="page"` : ''}>Drafts & unpaid</a><a href="/invoices?filter=all" ${filter === 'all' ? html`aria-current="page"` : ''}>All recent</a></span></div>
        ${rows.length ? html`<table class="table"><thead><tr><th>Invoice</th><th>Patient</th><th>Status</th><th>Created</th><th class="num">Total</th><th class="num">Balance</th></tr></thead>
          <tbody>${rows.map((i) => html`<tr><td><a href="/invoices/${i.id}">${i.invoice_no ?? 'Draft'}</a></td><td>${i.patient_name} <span class="muted">${i.patient_no}</span></td>
            <td>${statusBadge(i.status, i.status)}</td><td>${fmtDateTime(i.created_at, ctx.branch.timezone)}</td><td class="num">${money(ctx, i.total_minor)}</td>
            <td class="num">${i.status === 'issued' ? money(ctx, i.balance_minor) : '—'}</td></tr>`)}</tbody></table>`
          : emptyState('Nothing outstanding', 'Invoices are created from a patient record or a completed appointment.')}` }));
  });

  app.post('/invoices/new', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    const f = formOf(req);
    const id = createDraftInvoice(a.ctx, { patient_id: f.patient_id ?? '', appointment_id: f.appointment_id || undefined });
    return reply.redirect(`/invoices/${id}`);
  });

  app.get('/invoices/:id', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    return sendPage(reply, invoicePage(a.ctx, a.csrf, getInvoice(a.ctx, (req.params as { id: string }).id), flashFromQuery(req)));
  });

  // Generic POST handler: run the action, redirect with a message, or re-render with the error.
  const action = (path: string, run: (ctx: Ctx, id: string, f: Form, params: Record<string, string>) => string) =>
    app.post(path, async (req, reply) => {
      const a = requireAuth(req, reply);
      if (!a) return;
      const params = req.params as Record<string, string>;
      const f = formOf(req);
      try {
        return reply.redirect(run(a.ctx, params.id!, f, params));
      } catch (e) {
        if (!(e instanceof AppError) || (e.status !== 422 && e.status !== 409)) throw e;
        const invoiceId = path.startsWith('/payments') ? getPayment(a.ctx, params.id!).invoice_id : params.id!;
        // Keep a fresh payment_id unless this was a payment form error (then reuse it for idempotency).
        return sendPage(reply, invoicePage(a.ctx, a.csrf, getInvoice(a.ctx, invoiceId), { kind: 'error', text: e.message }, e.fields, f), e.status);
      }
    });

  action('/invoices/:id/lines', (ctx, id, f) => (addLine(ctx, id, f), `/invoices/${id}?msg=line_added`));
  action('/invoices/:id/lines/:lineId/delete', (ctx, id, _f, p) => (removeLine(ctx, id, p.lineId!), `/invoices/${id}?msg=line_removed`));
  action('/invoices/:id/discount', (ctx, id, f) => (setInvoiceDiscount(ctx, id, f.invoice_discount ?? ''), `/invoices/${id}?msg=discount_saved`));
  action('/invoices/:id/issue', (ctx, id) => (issueInvoice(ctx, id), `/invoices/${id}?msg=invoice_issued`));
  action('/invoices/:id/void', (ctx, id, f) => (voidInvoice(ctx, id, f.reason ?? ''), `/invoices/${id}?msg=invoice_voided`));
  action('/invoices/:id/delete', (ctx, id) => {
    const inv = getInvoice(ctx, id);
    deleteDraft(ctx, id);
    return `/patients/${inv.patient_id}?msg=draft_deleted`;
  });
  action('/invoices/:id/payments', (ctx, id, f) => {
    const r = recordPayment(ctx, id, { payment_id: f.payment_id ?? '', amount: f.amount ?? '', method: f.method ?? '', reference: f.reference, notes: f.notes });
    return `/invoices/${id}?msg=${r.duplicate ? 'payment_duplicate' : 'payment_recorded'}`;
  });
  action('/payments/:id/reverse', (ctx, id, f) => {
    const p = getPayment(ctx, id);
    reversePayment(ctx, id, f.reason ?? '');
    return `/invoices/${p.invoice_id}?msg=payment_reversed`;
  });

  app.get('/payments/:id/print', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    const { ctx } = a;
    const p = getPayment(ctx, (req.params as { id: string }).id);
    const inv = getInvoice(ctx, p.invoice_id);
    const tz = ctx.branch.timezone;
    return sendPage(reply, `<!doctype html>` + html`<html lang="en"><head><meta charset="utf-8"><title>Payment acknowledgement ${p.payment_no}</title>
      <link rel="stylesheet" href="/static/app.css"><script src="/static/app.js" defer></script></head><body class="print">
      <div class="print-doc">
        <h1>${ctx.org.name}</h1><p>${ctx.branch.name}<br>${ctx.branch.address}<br>${ctx.branch.phone}</p>
        <h2>Payment acknowledgement</h2>
        <p class="notice">This is an acknowledgement of payment received. It is not an official receipt or tax invoice.</p>
        <dl class="dl"><dt>Acknowledgement no.</dt><dd>${p.payment_no}</dd><dt>Date received</dt><dd>${fmtDateTime(p.received_at, tz)}</dd>
          <dt>Received from</dt><dd>${p.patient_name} (${p.patient_no})</dd><dt>For invoice</dt><dd>${p.invoice_no}</dd>
          <dt>Amount</dt><dd><strong>${money(ctx, p.amount_minor)}</strong></dd><dt>Method</dt><dd>${PAYMENT_METHODS[p.method]}${p.reference ? ` · Ref ${p.reference}` : ''}</dd>
          <dt>Received by</dt><dd>${p.received_by_name}</dd>
          <dt>Invoice balance now</dt><dd>${money(ctx, inv.balance_minor)}</dd></dl>
        ${p.reversed_at ? html`<p class="notice error">This payment was REVERSED on ${fmtDateTime(p.reversed_at, tz)}: ${p.reversal_reason}</p>` : ''}
        <p class="no-print"><button data-print>Print</button></p>
      </div></body></html>`.value);
  });
}
