// Multi-branch screens: consolidated organization report, conflict review, manual sync.
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { listConflicts, resolveConflict } from '../../domain/conflicts.js';
import { requirePerm } from '../../domain/context.js';
import { orgReport, STALE_MINUTES } from '../../domain/org-report.js';
import { syncOnce } from '../../sync/worker.js';
import { AppError, html } from '../../lib/core.js';
import { fmtDateTime } from '../../lib/time.js';
import { csrfInput, emptyState, money, page } from '../ui.js';
import { formOf, queryOf, requireAuth, sendPage, type Deps } from '../app.js';

const FRESH_LABEL = { live: 'Live', current: 'Up to date', stale: 'Stale', no_data: 'No data' } as const;
const FRESH_CLASS = { live: 'completed', current: 'confirmed', stale: 'warn', no_data: 'cancelled' } as const;

export function registerSyncRoutes(app: FastifyInstance, { db }: Deps): void {
  app.get('/reports/organization', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    const { ctx } = a;
    const q = queryOf(req);
    const r = orgReport(ctx, q.from ?? '', q.to ?? '');
    const tz = r.tz;
    const range = r.from === r.to ? DateTime.fromISO(r.from).toFormat('d MMM yyyy') : `${DateTime.fromISO(r.from).toFormat('d MMM')} – ${DateTime.fromISO(r.to).toFormat('d MMM yyyy')}`;
    return sendPage(reply, page({
      title: 'Organization report', ctx, csrf: a.csrf, active: 'organization',
      body: html`<div class="page-head"><h1>${ctx.org.name} — all branches</h1><button data-print class="button">Print</button></div>
        <form method="get" class="toolbar">
          <label for="from">From</label><input id="from" type="date" name="from" value="${r.from}">
          <label for="to">To</label><input id="to" type="date" name="to" value="${r.to}">
          <button>Show</button>
          <a class="button" href="/reports/organization">Today</a>
          <a class="button" href="/reports/organization?from=${DateTime.fromISO(r.to).startOf('month').toISODate()}&to=${r.to}">Month to date</a>
        </form>
        ${r.incomplete
          ? html`<div class="flash warn" role="alert"><strong>This report may be incomplete.</strong> Some branches' latest data has not reached this server:
              <ul>${r.incomplete_reasons.map((x) => html`<li>${x}</li>`)}</ul>Figures for those branches are as of the time shown in the table.</div>`
          : html`<div class="flash ok">All branches are up to date (within ${STALE_MINUTES} minutes).</div>`}
        <p class="muted">${range} · day boundaries in ${tz} · generated ${fmtDateTime(r.generated_at, tz)} from this server's copy of each branch's data.</p>
        <div class="grid-wrap"><table class="table">
          <thead><tr><th>Branch</th><th>Data freshness</th><th class="num">Payments received</th><th class="num">Reversals</th><th class="num">Net collections</th>
            <th class="num">Charges issued</th><th class="num">Outstanding (now)</th><th class="num">Appointments</th><th class="num">Completed</th><th class="num">No-shows</th><th class="num">Cancelled</th></tr></thead>
          <tbody>${r.rows.map((b) => html`<tr>
            <td><strong>${b.name}</strong> <span class="muted">${b.code}</span></td>
            <td><span class="badge st-${FRESH_CLASS[b.freshness]}">${FRESH_LABEL[b.freshness]}</span><br><span class="muted">${b.freshness === 'live' ? 'This branch' : b.data_as_of ? `as of ${fmtDateTime(b.data_as_of, tz)}` : b.freshness_note}</span></td>
            <td class="num">${money(ctx, b.received_minor)}</td><td class="num">${b.reversed_minor ? `− ${money(ctx, b.reversed_minor)}` : '—'}</td>
            <td class="num"><strong>${money(ctx, b.net_minor)}</strong></td><td class="num">${money(ctx, b.charges_minor)}</td><td class="num">${money(ctx, b.outstanding_minor)}</td>
            <td class="num">${b.appointments}</td><td class="num">${b.completed}</td><td class="num">${b.no_shows}</td><td class="num">${b.cancelled}</td></tr>`)}</tbody>
          <tfoot><tr><td colspan="2">All branches${r.incomplete ? ' (may be incomplete)' : ''}</td>
            <td class="num">${money(ctx, r.totals.received_minor)}</td><td class="num">${r.totals.reversed_minor ? `− ${money(ctx, r.totals.reversed_minor)}` : '—'}</td>
            <td class="num">${money(ctx, r.totals.net_minor)}</td><td class="num">${money(ctx, r.totals.charges_minor)}</td><td class="num">${money(ctx, r.totals.outstanding_minor)}</td>
            <td class="num">${r.totals.appointments}</td><td class="num">${r.totals.completed}</td><td class="num">${r.totals.no_shows}</td><td class="num">${r.totals.cancelled}</td></tr></tfoot>
        </table></div>
        <p class="hint">Net collections = payments received − reversals recorded in the period. These are cash-flow figures recorded in DentalSys, not accounting profit or tax figures.
          "Stale" means that branch has not synchronized for over ${STALE_MINUTES} minutes (for example, its internet is down); its own server still has complete data.</p>`,
    }));
  });

  app.get('/sync/conflicts', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    const { ctx } = a;
    const showResolved = queryOf(req).status === 'resolved';
    const rows = listConflicts(ctx, showResolved ? 'resolved' : 'open');
    const tz = ctx.branch.timezone;
    const val = (v: string | null, hidden: boolean) => (hidden ? html`<em class="muted">Medical detail hidden</em>` : v ? v : html`<em class="muted">(empty)</em>`);
    return sendPage(reply, page({
      title: 'Records to review', ctx, csrf: a.csrf,
      flash: queryOf(req).msg === 'resolved' ? { kind: 'ok', text: 'Conflict resolved. The decision will be shared with all branches.' } : null,
      body: html`<h1>Patient records to review</h1>
        <p class="muted">The same detail was changed differently at two branches (usually while one was offline). DentalSys kept the value that reached the cloud first and did not overwrite anything. Choose the correct value.</p>
        <div class="toolbar"><span class="seg"><a href="/sync/conflicts" ${!showResolved ? html`aria-current="page"` : ''}>To review</a><a href="/sync/conflicts?status=resolved" ${showResolved ? html`aria-current="page"` : ''}>Resolved</a></span></div>
        ${rows.length ? html`<table class="table"><thead><tr><th>Patient</th><th>Detail</th><th>Current value</th><th>Other branch's value</th><th>Changed at</th>${showResolved ? html`<th>Resolution</th>` : html`<th>Decision</th>`}</tr></thead>
          <tbody>${rows.map((c) => html`<tr>
            <td><a href="/patients/${c.entity_id}">${c.patient_name}</a><br><span class="muted">${c.patient_no}</span></td>
            <td>${c.field.replace(/_/g, ' ')}${c.medical ? html` <span class="badge st-warn">medical</span>` : ''}</td>
            <td>${val(c.kept_value, c.values_hidden)}</td><td>${val(c.incoming_value, c.values_hidden)}</td>
            <td>${c.incoming_branch ?? '—'}<br><span class="muted">${c.incoming_actor ?? ''} · ${fmtDateTime(c.detected_at, tz)}</span></td>
            <td>${showResolved ? (c as unknown as { resolution: string }).resolution : html`<form method="post" action="/sync/conflicts/${c.id}/resolve" class="button-row">${csrfInput(a.csrf)}
              <button name="choice" value="keep">Keep current</button><button name="choice" value="incoming" class="primary">Use other branch's</button></form>`}</td></tr>`)}</tbody></table>`
          : emptyState(showResolved ? 'No resolved conflicts yet' : 'Nothing to review', 'When two branches change the same patient detail differently, it appears here.')}`,
    }));
  });

  app.post('/sync/conflicts/:id/resolve', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    try {
      resolveConflict(a.ctx, (req.params as { id: string }).id, formOf(req).choice ?? '');
    } catch (e) {
      if (!(e instanceof AppError) || e.status >= 500) throw e;
      return sendPage(reply, page({ title: 'Cannot resolve', ctx: a.ctx, csrf: a.csrf, body: html`<h1>Cannot resolve</h1><p>${e.message}</p><p><a href="/sync/conflicts">Back</a></p>` }), e.status);
    }
    return reply.redirect('/sync/conflicts?msg=resolved');
  });

  app.post('/admin/sync-now', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    requirePerm(a.ctx, 'backup.run');
    await syncOnce(db);
    return reply.redirect('/admin#sync');
  });
}
