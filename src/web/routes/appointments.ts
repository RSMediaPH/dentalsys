// Calendar (day by chair, week list), booking, status changes, rescheduling with history.
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import {
  allowedTransitions, appointmentHistory, bookAppointment, changeStatus, getAppointment, listAppointments, rescheduleAppointment,
  STATUS_LABELS, type AppointmentView,
} from '../../domain/appointments.js';
import { listServices } from '../../domain/billing.js';
import { can, requirePerm, type Ctx } from '../../domain/context.js';
import { branchHours, listDentists, listOperatories } from '../../domain/orgs.js';
import { getPatientSummary, searchPatients } from '../../domain/patients.js';
import { AppError, html, isUuid, type SafeHtml } from '../../lib/core.js';
import { fmtDate, fmtDateTime, fmtTime, isValidDate, minutesToHHMM, toLocal, todayIn } from '../../lib/time.js';
import { csrfInput, emptyState, field, page, select, statusBadge, textarea } from '../ui.js';
import { flashFromQuery, formOf, queryOf, requireAuth, sendPage, type Deps, type Form } from '../app.js';

const SLOT = 15;

function dayGrid(ctx: Ctx, date: string, appts: AppointmentView[]): SafeHtml {
  const tz = ctx.branch.timezone;
  const chairs = listOperatories(ctx);
  const weekday = DateTime.fromISO(date, { zone: tz }).weekday;
  const hours = branchHours(ctx.db, ctx.branch.id).get(weekday);
  if (!hours) return emptyState('Branch closed', `${ctx.branch.name} has no operating hours on ${DateTime.fromISO(date).toFormat('cccc')}.`);
  if (!chairs.length) return emptyState('No chairs set up', 'Ask a manager to add chairs/operatories for this branch.');
  const active = appts.filter((a) => a.status !== 'cancelled' && a.status !== 'no_show');
  const minuteOf = (iso: string) => { const d = toLocal(iso, tz); return d.hour * 60 + d.minute; };
  const rows: SafeHtml[] = [];
  const covered = new Map<string, number>(); // chair -> minute until which a rowspan covers
  const canBook = can(ctx, 'appointment.manage');
  for (let m = hours.open; m < hours.close; m += SLOT) {
    const cells = chairs.map((c) => {
      if ((covered.get(c.id) ?? -1) > m) return '';
      const a = active.find((x) => x.operatory_id === c.id && minuteOf(x.start_at) < m + SLOT && minuteOf(x.end_at) > m && minuteOf(x.start_at) >= m - SLOT + 1);
      if (a) {
        const end = Math.min(minuteOf(a.end_at), hours.close);
        const span = Math.max(1, Math.ceil((end - m) / SLOT));
        covered.set(c.id, m + span * SLOT);
        return html`<td rowspan="${span}" class="appt st-${a.status}"><a href="/appointments/${a.id}">
          <strong>${a.patient_name}</strong><br><span>${fmtTime(a.start_at, tz)}–${fmtTime(a.end_at, tz)}</span><br>
          <span>${a.service_name ?? ''}</span> <span class="muted">${a.dentist_name}</span><br>${statusBadge(a.status, STATUS_LABELS[a.status])}</a></td>`;
      }
      return html`<td class="free">${canBook ? html`<a href="/appointments/new?date=${date}&time=${minutesToHHMM(m)}&operatory_id=${c.id}" aria-label="Book ${c.name} at ${minutesToHHMM(m)}">+</a>` : ''}</td>`;
    });
    rows.push(html`<tr><th scope="row" class="time">${m % 60 === 0 ? minutesToHHMM(m) : ''}</th>${cells}</tr>`);
  }
  return html`<div class="grid-wrap"><table class="calendar"><thead><tr><th class="time"></th>${chairs.map((c) => html`<th scope="col">${c.name}</th>`)}</tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function weekList(ctx: Ctx, start: string, appts: AppointmentView[]): SafeHtml {
  const tz = ctx.branch.timezone;
  const days = Array.from({ length: 7 }, (_, i) => DateTime.fromISO(start, { zone: tz }).plus({ days: i }));
  return html`<div class="week">${days.map((d) => {
    const list = appts.filter((a) => toLocal(a.start_at, tz).toISODate() === d.toISODate() && a.status !== 'cancelled');
    return html`<section class="day"><h3><a href="/appointments?date=${d.toISODate()}">${d.toFormat('ccc d MMM')}</a></h3>
      ${list.length ? html`<ul>${list.map((a) => html`<li><a href="/appointments/${a.id}"><strong>${fmtTime(a.start_at, tz)}</strong> ${a.patient_name}</a>
        <br><span class="muted">${a.dentist_name} · ${a.operatory_name}</span> ${statusBadge(a.status, STATUS_LABELS[a.status])}</li>`)}</ul>` : html`<p class="muted">No appointments</p>`}</section>`;
  })}</div>`;
}

function bookingForm(ctx: Ctx, csrf: string, v: Form, errors: Record<string, string>): SafeHtml {
  const services = listServices(ctx);
  const patient = v.patient_id && isUuid(v.patient_id) ? getPatientSummary(ctx, v.patient_id) : null;
  const keep = (extra: Record<string, string>) =>
    new URLSearchParams(Object.fromEntries(Object.entries({ ...v, ...extra }).filter(([k, x]) => x && k !== '_csrf'))).toString();
  if (!patient) {
    const q = v.q ?? '';
    const results = q ? searchPatients(ctx, q) : [];
    return html`<h2>1. Choose the patient</h2>
      <form method="get" action="/appointments/new" class="search-bar" role="search">
        ${Object.entries(v).filter(([k]) => !['q', '_csrf', 'patient_id'].includes(k)).map(([k, x]) => html`<input type="hidden" name="${k}" value="${x}">`)}
        <label for="q" class="sr-only">Find patient</label><input id="q" name="q" type="search" value="${q}" placeholder="Name, patient no. or phone" autofocus>
        <button>Search</button></form>
      ${errors.patient_id ? html`<p class="error-text">${errors.patient_id}</p>` : ''}
      ${q ? (results.length
        ? html`<table class="table"><tbody>${results.map((r) => html`<tr><td>${r.patient_no}</td><td>${r.name}</td><td>${fmtDate(r.date_of_birth)}</td><td>${r.phone_hint}</td>
            <td><a class="button" href="/appointments/new?${keep({ patient_id: r.id, q: '' })}">Select</a></td></tr>`)}</tbody></table>`
        : emptyState('No match', 'Register the patient first, then book.', html`<a class="button" href="/patients/new">Register patient</a>`)) : ''}`;
  }
  return html`<form method="post" action="/appointments/new" class="stack" novalidate>${csrfInput(csrf)}
    <input type="hidden" name="patient_id" value="${patient.id}">
    <p><strong>Patient:</strong> ${patient.full_name} <span class="muted">${patient.patient_no}</span> · <a href="/appointments/new?${keep({ patient_id: '' })}">change</a>
      ${patient.has_medical_alerts ? html` <span class="badge st-warn">Medical alerts</span>` : ''}</p>
    <div class="grid3">
      ${select('Procedure', 'service_id', services.map((s) => ({ value: s.id, label: `${s.name} (${s.default_duration_min} min)`, attrs: html`data-duration="${s.default_duration_min}"` })), v.service_id ?? '', { placeholder: '— General / unspecified —', errors })}
      ${select('Dentist', 'dentist_id', listDentists(ctx).map((d) => ({ value: d.id, label: d.name })), v.dentist_id ?? '', { required: true, placeholder: 'Choose…', errors })}
      ${select('Chair', 'operatory_id', listOperatories(ctx).map((o) => ({ value: o.id, label: o.name })), v.operatory_id ?? '', { required: true, placeholder: 'Choose…', errors })}
      ${field('Date', 'date', v.date ?? todayIn(ctx.branch.timezone), { type: 'date', required: true, errors })}
      ${field('Start time', 'time', v.time ?? '', { type: 'time', required: true, errors, attrs: html`step="300"` })}
      ${field('Duration (minutes)', 'duration_min', v.duration_min ?? '30', { type: 'number', required: true, errors, attrs: html`min="5" max="480" step="5"` })}
    </div>
    ${textarea('Notes for the front desk (not clinical notes)', 'notes', v.notes ?? '', errors, 2)}
    <div class="actions"><button class="primary" type="submit">Book appointment</button><a href="/appointments">Cancel</a></div>
    <p class="hint">Times are in ${ctx.branch.timezone}. The clinic server checks branch hours, the dentist's working block and overlaps for the dentist and chair.</p>
  </form>`;
}

export function registerAppointmentRoutes(app: FastifyInstance, _deps: Deps): void {
  app.get('/appointments', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    const { ctx } = a;
    const q = queryOf(req);
    const tz = ctx.branch.timezone;
    const date = q.date && isValidDate(q.date) ? q.date : todayIn(tz);
    const view = q.view === 'week' ? 'week' : 'day';
    const d = DateTime.fromISO(date, { zone: tz });
    const start = view === 'week' ? d.startOf('week').toISODate()! : date;
    const appts = listAppointments(ctx, start, view === 'week' ? 7 : 1, { dentistId: q.dentist_id });
    const step = view === 'week' ? { weeks: 1 } : { days: 1 };
    const nav = (dt: DateTime) => `/appointments?view=${view}&date=${dt.toISODate()}${q.dentist_id ? `&dentist_id=${q.dentist_id}` : ''}`;
    return sendPage(reply, page({
      title: 'Calendar', ctx, csrf: a.csrf, active: 'appointments', flash: flashFromQuery(req),
      body: html`<div class="page-head"><h1>${view === 'week' ? `Week of ${DateTime.fromISO(start).toFormat('d MMM yyyy')}` : d.toFormat('cccc, d MMM yyyy')}</h1>
        ${can(ctx, 'appointment.manage') ? html`<a class="button primary" href="/appointments/new?date=${date}">Book appointment</a>` : ''}</div>
        <div class="toolbar">
          <a class="button" href="${nav(d.minus(step))}">← Previous</a>
          <a class="button" href="/appointments?view=${view}">Today</a>
          <a class="button" href="${nav(d.plus(step))}">Next →</a>
          <span class="seg"><a href="/appointments?view=day&date=${date}" ${view === 'day' ? html`aria-current="page"` : ''}>Day</a><a href="/appointments?view=week&date=${date}" ${view === 'week' ? html`aria-current="page"` : ''}>Week</a></span>
          <form method="get" action="/appointments" class="inline"><input type="hidden" name="view" value="${view}"><input type="hidden" name="date" value="${date}">
            <label for="dentist-filter" class="sr-only">Dentist</label>
            <select id="dentist-filter" name="dentist_id" data-autosubmit><option value="">All dentists</option>
              ${listDentists(ctx).map((x) => html`<option value="${x.id}" ${x.id === q.dentist_id ? html`selected` : ''}>${x.name}</option>`)}</select>
            <noscript><button>Filter</button></noscript></form>
          <form method="get" action="/appointments" class="inline"><input type="hidden" name="view" value="${view}"><label for="goto" class="sr-only">Go to date</label>
            <input id="goto" type="date" name="date" value="${date}"><button>Go</button></form>
        </div>
        ${view === 'day' ? dayGrid(ctx, date, appts) : weekList(ctx, start, appts)}
        <p class="hint">This calendar belongs to ${ctx.branch.name} and is controlled by this branch's server. Bookings at other branches are not visible here.</p>`,
    }));
  });

  app.get('/appointments/new', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    requirePerm(a.ctx, 'appointment.manage');
    return sendPage(reply, page({ title: 'Book appointment', ctx: a.ctx, csrf: a.csrf, active: 'appointments',
      body: html`<h1>Book appointment</h1>${bookingForm(a.ctx, a.csrf, queryOf(req), {})}` }));
  });

  app.post('/appointments/new', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    const f = formOf(req);
    try {
      const appt = bookAppointment(a.ctx, f);
      return reply.redirect(`/appointments/${appt.id}?msg=appointment_booked`);
    } catch (e) {
      if (!(e instanceof AppError) || (e.status !== 422 && e.status !== 409)) throw e;
      return sendPage(reply, page({ title: 'Book appointment', ctx: a.ctx, csrf: a.csrf, active: 'appointments', flash: { kind: 'error', text: e.message },
        body: html`<h1>Book appointment</h1>${bookingForm(a.ctx, a.csrf, f, e.fields)}` }), e.status);
    }
  });

  const detail = (ctx: Ctx, csrf: string, id: string, flash: { kind: 'ok' | 'error' | 'warn'; text: string } | null, resErrors: Record<string, string> = {}, resValues?: Form) => {
    const x = getAppointment(ctx, id);
    const tz = ctx.branch.timezone;
    const history = appointmentHistory(ctx, id);
    const manage = can(ctx, 'appointment.manage');
    const local = toLocal(x.start_at, tz);
    const rv: Form = resValues ?? { dentist_id: x.dentist_membership_id, operatory_id: x.operatory_id, date: local.toISODate()!, time: local.toFormat('HH:mm'),
      duration_min: String(Math.round(toLocal(x.end_at, tz).diff(local, 'minutes').minutes)) };
    const describe = (h: { kind: string; details_json: string }) => {
      const d = JSON.parse(h.details_json);
      if (h.kind === 'status_changed') return `Status: ${STATUS_LABELS[d.from as keyof typeof STATUS_LABELS]} → ${STATUS_LABELS[d.to as keyof typeof STATUS_LABELS]}`;
      if (h.kind === 'rescheduled') return `Moved from ${fmtDateTime(d.from.start_at, tz)} to ${fmtDateTime(d.to.start_at, tz)}`;
      return `Booked for ${fmtDateTime(d.start_at, tz)}`;
    };
    return page({
      title: 'Appointment', ctx, csrf, active: 'appointments', flash,
      body: html`<div class="page-head"><div><h1>${x.patient_name}</h1><p class="muted">${fmtDateTime(x.start_at, tz)} – ${fmtTime(x.end_at, tz)} · ${statusBadge(x.status, STATUS_LABELS[x.status])}</p></div>
        <div class="actions"><a class="button" href="/patients/${x.patient_id}">Patient record</a>
        ${can(ctx, 'invoice.draft') && ['arrived', 'in_progress', 'completed'].includes(x.status)
          ? html`<form method="post" action="/invoices/new" class="inline">${csrfInput(csrf)}<input type="hidden" name="patient_id" value="${x.patient_id}"><input type="hidden" name="appointment_id" value="${x.id}"><button class="primary">Create invoice</button></form>` : ''}</div></div>
      <dl class="dl"><dt>Patient no.</dt><dd>${x.patient_no}</dd><dt>Dentist</dt><dd>${x.dentist_name}</dd><dt>Chair</dt><dd>${x.operatory_name}</dd>
        <dt>Procedure</dt><dd>${x.service_name ?? '—'}</dd><dt>Front-desk notes</dt><dd>${x.notes || '—'}</dd></dl>
      ${manage && allowedTransitions(x.status).length ? html`<h2>Update status</h2><form method="post" action="/appointments/${x.id}/status" class="stack narrow">${csrfInput(csrf)}
        <input type="hidden" name="version" value="${x.version}">
        <div class="button-row">${allowedTransitions(x.status).map((s) => html`<button name="status" value="${s}" class="${s === 'cancelled' || s === 'no_show' ? 'danger' : ''}" ${s === 'cancelled' ? html`data-needs-reason` : ''}>${STATUS_LABELS[s]}</button>`)}</div>
        ${field('Reason (required to cancel)', 'reason', '', { hint: 'For example: patient called to cancel' })}</form>` : ''}
      ${manage && ['scheduled', 'confirmed'].includes(x.status) ? html`<details ${Object.keys(resErrors).length ? html`open` : ''}><summary>Reschedule</summary>
        <form method="post" action="/appointments/${x.id}/reschedule" class="stack" novalidate>${csrfInput(csrf)}<input type="hidden" name="version" value="${x.version}">
        <div class="grid3">
          ${select('Dentist', 'dentist_id', listDentists(ctx).map((d) => ({ value: d.id, label: d.name })), rv.dentist_id ?? '', { required: true, errors: resErrors })}
          ${select('Chair', 'operatory_id', listOperatories(ctx).map((o) => ({ value: o.id, label: o.name })), rv.operatory_id ?? '', { required: true, errors: resErrors })}
          ${field('Date', 'date', rv.date, { type: 'date', required: true, errors: resErrors })}
          ${field('Start time', 'time', rv.time, { type: 'time', required: true, errors: resErrors })}
          ${field('Duration (minutes)', 'duration_min', rv.duration_min, { type: 'number', required: true, errors: resErrors })}
          ${field('Reason', 'reason', rv.reason ?? '', { required: true, errors: resErrors })}
        </div><div class="actions"><button class="primary">Save new time</button></div></form></details>` : ''}
      <h2>History</h2><ol class="timeline">${history.map((h) => html`<li><span class="muted">${fmtDateTime(h.at, tz)} · ${h.actor}</span><br>${describe(h)}${h.reason ? html` — <em>${h.reason}</em>` : ''}</li>`)}</ol>`,
    });
  };

  app.get('/appointments/:id', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    return sendPage(reply, detail(a.ctx, a.csrf, (req.params as { id: string }).id, flashFromQuery(req)));
  });

  app.post('/appointments/:id/status', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    const id = (req.params as { id: string }).id;
    const f = formOf(req);
    try {
      changeStatus(a.ctx, id, f.status ?? '', f.reason ?? '', Number(f.version));
      return reply.redirect(`/appointments/${id}?msg=appointment_updated`);
    } catch (e) {
      if (!(e instanceof AppError) || (e.status !== 422 && e.status !== 409)) throw e;
      return sendPage(reply, detail(a.ctx, a.csrf, id, { kind: 'error', text: e.message }), e.status);
    }
  });

  app.post('/appointments/:id/reschedule', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    const id = (req.params as { id: string }).id;
    const f = formOf(req);
    try {
      rescheduleAppointment(a.ctx, id, f, Number(f.version));
      return reply.redirect(`/appointments/${id}?msg=appointment_updated`);
    } catch (e) {
      if (!(e instanceof AppError) || (e.status !== 422 && e.status !== 409)) throw e;
      return sendPage(reply, detail(a.ctx, a.csrf, id, { kind: 'error', text: e.message }, { ...e.fields, ...(e.status === 409 ? { time: e.message } : {}) }, f), e.status);
    }
  });
}
