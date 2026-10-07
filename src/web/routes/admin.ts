// Daily collections report and administration (backups, audit log, settings overview).
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { runBackup, backupOverview } from '../../backup/backup.js';
import { can, requirePerm } from '../../domain/context.js';
import { dentistBlocks, listOperatories, branchHours } from '../../domain/orgs.js';
import { syncStatus } from '../../domain/outbox.js';
import { dailyCollections } from '../../domain/reports.js';
import { PAYMENT_METHODS } from '../../domain/billing.js';
import { audit } from '../../domain/context.js';
import { html } from '../../lib/core.js';
import { fmtDateTime, isValidDate, minutesToHHMM, todayIn } from '../../lib/time.js';
import { csrfInput, emptyState, money, page } from '../ui.js';
import { flashFromQuery, queryOf, requireAuth, sendPage, type Deps } from '../app.js';

export function registerReportAndAdminRoutes(app: FastifyInstance, { db, cfg }: Deps): void {
  app.get('/reports/collections', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    const { ctx } = a;
    const q = queryOf(req);
    const date = q.date && isValidDate(q.date) ? q.date : todayIn(ctx.branch.timezone);
    const r = dailyCollections(ctx, date);
    const tz = ctx.branch.timezone;
    const d = DateTime.fromISO(date);
    return sendPage(reply, page({
      title: 'Daily collections', ctx, csrf: a.csrf, active: 'reports',
      body: html`<div class="page-head"><h1>Daily collections — ${d.toFormat('cccc, d MMM yyyy')}</h1><button data-print class="button">Print</button></div>
        <div class="toolbar"><a class="button" href="/reports/collections?date=${d.minus({ days: 1 }).toISODate()}">← Previous day</a>
          <a class="button" href="/reports/collections">Today</a><a class="button" href="/reports/collections?date=${d.plus({ days: 1 }).toISODate()}">Next day →</a>
          <form method="get" class="inline"><label for="rd" class="sr-only">Date</label><input id="rd" type="date" name="date" value="${date}"><button>Go</button></form></div>
        <p class="muted">${ctx.branch.name} · day boundaries in ${tz} · generated ${fmtDateTime(r.generated_at, tz)}. Source: this branch's server (complete for this branch).</p>
        <div class="kpis">
          <div class="kpi"><span>Payments received</span><strong data-testid="received">${money(ctx, r.received_minor)}</strong><small>${r.payments.length} payment(s)</small></div>
          <div class="kpi"><span>Reversals recorded this day</span><strong>${r.reversed_minor ? `− ${money(ctx, r.reversed_minor)}` : money(ctx, 0)}</strong><small>${r.reversals.length} reversal(s)</small></div>
          <div class="kpi"><span>Net collections</span><strong data-testid="net">${money(ctx, r.net_minor)}</strong><small>received − reversals</small></div>
          <div class="kpi"><span>Charges issued this day</span><strong>${money(ctx, r.charges_issued_minor)}</strong><small>${r.invoices_issued} invoice(s)</small></div>
          <div class="kpi due"><span>Outstanding balances (branch, now)</span><strong>${money(ctx, r.outstanding_minor)}</strong></div>
        </div>
        <div class="cols">
          <section><h2>By payment method</h2>${r.byMethod.length ? html`<table class="table compact"><tbody>${r.byMethod.map((m) => html`<tr><td>${PAYMENT_METHODS[m.method]}</td><td class="num">${m.count}</td><td class="num">${money(ctx, m.amount_minor)}</td></tr>`)}</tbody></table>` : html`<p class="muted">None</p>`}</section>
          <section><h2>By dentist on invoice</h2>${r.byDentist.length ? html`<table class="table compact"><tbody>${r.byDentist.map((m) => html`<tr><td>${m.dentist}</td><td class="num">${money(ctx, m.amount_minor)}</td></tr>`)}</tbody></table>` : html`<p class="muted">None</p>`}</section>
        </div>
        <h2>Payments received</h2>
        ${r.payments.length ? html`<table class="table"><thead><tr><th>Time</th><th>Payment no.</th><th>Patient</th><th>Invoice</th><th>Method</th><th>Received by</th><th class="num">Amount</th></tr></thead>
          <tbody>${r.payments.map((p) => html`<tr class="${p.reversed ? 'reversed' : ''}"><td>${fmtDateTime(p.received_at, tz)}</td><td>${p.payment_no}${p.reversed ? html` <span class="badge st-cancelled">reversed</span>` : ''}</td>
            <td>${p.patient_name} <span class="muted">${p.patient_no}</span></td><td><a href="/invoices/${p.invoice_id}">${p.invoice_no}</a></td><td>${PAYMENT_METHODS[p.method]}${p.reference ? ` · ${p.reference}` : ''}</td>
            <td>${p.received_by}</td><td class="num">${money(ctx, p.amount_minor)}</td></tr>`)}</tbody></table>`
          : emptyState('No payments received on this day', 'Payments recorded at this branch will appear here.')}
        ${r.reversals.length ? html`<h2>Reversals recorded this day</h2><table class="table"><thead><tr><th>Reversed at</th><th>Payment no.</th><th>Originally received</th><th>By</th><th>Reason</th><th class="num">Amount</th></tr></thead>
          <tbody>${r.reversals.map((x) => html`<tr><td>${fmtDateTime(x.reversed_at, tz)}</td><td>${x.payment_no}</td><td>${fmtDateTime(x.original_received_at, tz)}</td><td>${x.reversed_by}</td><td>${x.reason}</td><td class="num">− ${money(ctx, x.amount_minor)}</td></tr>`)}</tbody></table>` : ''}
        <p class="hint">These are cash-flow figures recorded in this system, not accounting profit and not a tax report.</p>`,
    }));
  });

  app.get('/admin', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    const { ctx } = a;
    requirePerm(ctx, 'backup.view');
    const b = backupOverview(db, cfg);
    const s = syncStatus(db);
    const hours = branchHours(db, ctx.branch.id);
    const tz = ctx.branch.timezone;
    const days = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const last = b.runs.find((r) => r.status === 'succeeded');
    const lastFailed = b.runs[0]?.status === 'failed' ? b.runs[0] : null;
    return sendPage(reply, page({
      title: 'Administration', ctx, csrf: a.csrf, active: 'admin', flash: flashFromQuery(req),
      body: html`<h1>Administration — ${ctx.branch.name}</h1>
      <section class="card"><h2>Backups</h2>
        ${!b.keyPresent ? html`<div class="flash error">No backup key found. Backups cannot run. Run <code>npm run backup:keygen</code> on the server and store a copy of the key safely.</div>` : ''}
        ${lastFailed ? html`<div class="flash error">The most recent backup failed: ${lastFailed.error}</div>` : ''}
        ${b.sameDisk ? html`<div class="flash warn">Backups are stored on the same disk as the database. Set BACKUP_DIR to a second disk or USB drive, and enable cloud backup when available.</div>` : ''}
        <p>Last verified backup: <strong>${last ? fmtDateTime(last.finished_at, tz) : 'never'}</strong> · Daily schedule: ${b.dailyAt ?? 'disabled'} (server time) · Keep newest ${b.retention}</p>
        ${can(ctx, 'backup.run') ? html`<form method="post" action="/admin/backup" class="inline">${csrfInput(a.csrf)}<button class="primary" ${b.keyPresent ? '' : html`disabled`}>Back up now</button></form>` : ''}
        <table class="table compact"><thead><tr><th>Started</th><th>Type</th><th>Status</th><th>File</th><th class="num">Size</th><th>Verified</th></tr></thead>
          <tbody>${b.runs.map((r) => html`<tr><td>${fmtDateTime(r.started_at, tz)}</td><td>${r.kind}</td><td><span class="badge st-${r.status === 'succeeded' ? 'completed' : r.status === 'failed' ? 'cancelled' : 'scheduled'}">${r.status}</span>${r.error ? html`<br><span class="muted">${r.error}</span>` : ''}</td>
            <td>${r.file_name ?? '—'}</td><td class="num">${r.size_bytes ? `${(r.size_bytes / 1024).toFixed(0)} KB` : ''}</td><td>${r.verified_at ? 'Test-restored ✓' : '—'}</td></tr>`)}</tbody></table>
        <p class="hint">Restoring is done on the server with <code>npm run restore</code> into a new, empty folder — it never overwrites current data. See docs/07-backup-recovery.md.</p></section>
      <section class="card"><h2>Synchronization</h2>
        <p>Cloud: <strong>${s.cloudConfigured ? 'configured' : 'not set up (Milestone 2)'}</strong> · Changes waiting to sync: <strong>${s.pending}</strong> · Failed: ${s.failed} · Last successful sync: ${s.lastSuccessAt ? fmtDateTime(s.lastSuccessAt, tz) : 'never'}</p>
        <p class="hint">Every change at this branch is queued durably and will be sent once the cloud service is connected.</p></section>
      <section class="card"><h2>Branch setup</h2><p class="hint">Read-only in this version; editing screens are planned (see docs/09-scope-and-limitations.md).</p>
        <dl class="dl"><dt>Organization</dt><dd>${ctx.org.name} · currency ${ctx.org.currency} · tooth numbering ${ctx.org.tooth_numbering}</dd>
          <dt>Branch</dt><dd>${ctx.branch.name} (${ctx.branch.code}) · ${ctx.branch.address} · ${ctx.branch.phone} · ${tz}</dd>
          <dt>Hours</dt><dd>${[1, 2, 3, 4, 5, 6, 7].map((w) => { const h = hours.get(w); return `${days[w]} ${h ? `${minutesToHHMM(h.open)}–${minutesToHHMM(h.close)}` : 'closed'}`; }).join(' · ')}</dd>
          <dt>Chairs</dt><dd>${listOperatories(ctx).map((o) => o.name).join(', ')}</dd>
          <dt>Dentist working blocks</dt><dd>${dentistBlocks(ctx).map((x) => html`${x.name}: ${days[x.weekday]} ${minutesToHHMM(x.start_min)}–${minutesToHHMM(x.end_min)}<br>`)}</dd></dl></section>
      ${can(ctx, 'audit.view') ? html`<p><a class="button" href="/admin/audit">View audit log</a></p>` : ''}`,
    }));
  });

  app.post('/admin/backup', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    requirePerm(a.ctx, 'backup.run');
    audit(a.ctx, 'backup.manual_start');
    try {
      await runBackup(db, cfg, 'manual', a.ctx.user.id);
    } catch {
      return reply.redirect('/admin'); // failure is shown from backup_runs
    }
    return reply.redirect('/admin?msg=backup_done');
  });

  app.get('/admin/audit', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    const { ctx } = a;
    requirePerm(ctx, 'audit.view');
    const rows = db
      .prepare(`SELECT e.*, u.display_name AS actor FROM audit_events e LEFT JOIN users u ON u.id = e.actor_user_id
                WHERE e.org_id = ? AND (e.branch_id = ? OR e.branch_id IS NULL) ORDER BY e.at DESC LIMIT 300`)
      .all(ctx.org.id, ctx.branch.id) as { at: string; actor: string | null; action: string; entity_type: string; entity_id: string; ip: string; details_json: string }[];
    return sendPage(reply, page({ title: 'Audit log', ctx, csrf: a.csrf, active: 'admin',
      body: html`<h1>Audit log</h1><p class="muted">Most recent 300 events at ${ctx.branch.name}. Entries cannot be edited or deleted.</p>
        <table class="table compact"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Details</th><th>IP</th></tr></thead>
        <tbody>${rows.map((r) => html`<tr><td>${fmtDateTime(r.at, ctx.branch.timezone)}</td><td>${r.actor ?? '—'}</td><td><code>${r.action}</code></td>
          <td>${r.entity_type} ${r.entity_id ? html`<span class="muted">${r.entity_id.slice(-8)}</span>` : ''}</td><td><code>${r.details_json === '{}' ? '' : r.details_json}</code></td><td>${r.ip}</td></tr>`)}</tbody></table>` }));
  });
}
