// Login, logout, branch switching and the "Today" start page.
import type { FastifyInstance } from 'fastify';
import { destroySession, login, switchBranch } from '../../auth/auth.js';
import { can } from '../../domain/context.js';
import { listAppointments, STATUS_LABELS } from '../../domain/appointments.js';
import { html } from '../../lib/core.js';
import { fmtTime, todayIn } from '../../lib/time.js';
import { csrfInput, emptyState, field, page, statusBadge } from '../ui.js';
import { flashFromQuery, formOf, newPreloginToken, PRELOGIN_COOKIE, queryOf, requireAuth, sendPage, SESSION_COOKIE, type Deps } from '../app.js';

const safeNext = (n: string | undefined) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/');

export function registerAuthRoutes(app: FastifyInstance, { db, cfg }: Deps): void {
  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: cfg.cookieSecure };

  const loginPage = (token: string, next: string, error?: string, email = '') =>
    page({
      title: 'Sign in',
      body: html`<div class="login-card">
        <h1>Sign in</h1>
        <p class="muted">Dental Clinic Manager — clinic server</p>
        ${error ? html`<div class="flash error" role="alert">${error}</div>` : ''}
        <form method="post" action="/login" class="stack">
          <input type="hidden" name="_csrf" value="${token}">
          <input type="hidden" name="next" value="${next}">
          ${field('Email', 'email', email, { type: 'email', required: true, autofocus: !email, attrs: html`autocomplete="username"` })}
          ${field('Password', 'password', '', { type: 'password', required: true, autofocus: Boolean(email), attrs: html`autocomplete="current-password"` })}
          <button class="primary" type="submit">Sign in</button>
        </form>
        <p class="hint">Sign-in is checked by this clinic's server and works without internet.</p>
      </div>`,
    });

  app.get('/login', async (req, reply) => {
    if (req.auth) return reply.redirect('/');
    const token = newPreloginToken();
    reply.setCookie(PRELOGIN_COOKIE, token, { ...cookieOpts, maxAge: 3600 });
    return sendPage(reply, loginPage(token, safeNext(queryOf(req).next)));
  });

  app.post('/login', async (req, reply) => {
    const f = formOf(req);
    const result = await login(db, cfg, f.email ?? '', f.password ?? '', req.ip);
    if (!result.ok) {
      const msg = result.reason === 'throttled'
        ? 'Too many failed attempts. Please wait 15 minutes or ask a manager to help.'
        : result.reason === 'no_branch' ? 'Your account is not assigned to any branch. Ask your manager.' : 'Email or password is incorrect.';
      const token = newPreloginToken();
      reply.setCookie(PRELOGIN_COOKIE, token, { ...cookieOpts, maxAge: 3600 });
      return sendPage(reply, loginPage(token, safeNext(f.next), msg, f.email ?? ''), result.reason === 'throttled' ? 429 : 401);
    }
    reply.clearCookie(PRELOGIN_COOKIE, { path: '/' });
    reply.setCookie(SESSION_COOKIE, result.token, { ...cookieOpts, maxAge: cfg.sessionAbsoluteHours * 3600 });
    return reply.redirect(safeNext(f.next));
  });

  app.post('/logout', async (req, reply) => {
    destroySession(db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/login');
  });

  app.get('/switch-branch', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    const branches = db
      .prepare(`SELECT id, code, name FROM branches WHERE id IN (${a.ctx.assignedBranchIds.map(() => '?').join(',')}) ORDER BY name`)
      .all(...a.ctx.assignedBranchIds) as { id: string; code: string; name: string }[];
    return sendPage(reply, page({
      title: 'Switch branch', ctx: a.ctx, csrf: a.csrf,
      body: html`<h1>Switch branch</h1><p class="muted">You can work at the branches you are assigned to.</p>
        <ul class="list">${branches.map((b) => html`<li><form method="post" action="/switch-branch" class="inline">${csrfInput(a.csrf)}
          <input type="hidden" name="branch_id" value="${b.id}">
          <button ${b.id === a.ctx.branch.id ? html`disabled` : ''}>${b.name} (${b.code})${b.id === a.ctx.branch.id ? ' — current' : ''}</button></form></li>`)}</ul>`,
    }));
  });

  app.post('/switch-branch', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    if (!switchBranch(a.ctx, a.token, formOf(req).branch_id ?? '')) {
      return sendPage(reply, page({ title: 'Not permitted', ctx: a.ctx, csrf: a.csrf, body: html`<h1>Not permitted</h1><p>You are not assigned to that branch.</p>` }), 403);
    }
    return reply.redirect('/?msg=branch_switched');
  });

  // Start page: today's schedule at this branch + quick patient search.
  app.get('/', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    const { ctx } = a;
    const today = todayIn(ctx.branch.timezone);
    const appts = can(ctx, 'appointment.view') ? listAppointments(ctx, today, 1) : [];
    const active = appts.filter((x) => x.status !== 'cancelled');
    return sendPage(reply, page({
      title: 'Today', ctx, csrf: a.csrf, active: 'today', flash: flashFromQuery(req),
      body: html`
        <div class="page-head"><h1>Today at ${ctx.branch.name}</h1>
          <div class="actions">
            ${can(ctx, 'patient.create') ? html`<a class="button" href="/patients/new">Register patient</a>` : ''}
            ${can(ctx, 'appointment.manage') ? html`<a class="button primary" href="/appointments/new">Book appointment</a>` : ''}
          </div></div>
        ${can(ctx, 'patient.view') ? html`<form class="search-bar" method="get" action="/patients" role="search">
          <label for="q" class="sr-only">Find a patient</label>
          <input id="q" name="q" type="search" placeholder="Find patient by name, patient no. or phone   (press / to focus)" data-hotkey="/">
          <button>Search</button></form>` : ''}
        ${can(ctx, 'appointment.view')
          ? html`<h2>Appointments (${active.length})</h2>
          ${active.length
            ? html`<table class="table"><thead><tr><th>Time</th><th>Patient</th><th>Dentist</th><th>Chair</th><th>Procedure</th><th>Status</th></tr></thead>
              <tbody>${active.map((x) => html`<tr>
                <td><a href="/appointments/${x.id}">${fmtTime(x.start_at, ctx.branch.timezone)}–${fmtTime(x.end_at, ctx.branch.timezone)}</a></td>
                <td><a href="/patients/${x.patient_id}">${x.patient_name}</a> <span class="muted">${x.patient_no}</span></td>
                <td>${x.dentist_name}</td><td>${x.operatory_name}</td><td>${x.service_name ?? '—'}</td>
                <td>${statusBadge(x.status, STATUS_LABELS[x.status])}</td></tr>`)}</tbody></table>`
            : emptyState('No appointments today', 'Book an appointment to see it here.', can(ctx, 'appointment.manage') ? html`<a class="button" href="/appointments/new">Book appointment</a>` : undefined)}`
          : emptyState('Nothing to show here', 'Your role does not include scheduling or patient access. Inventory features arrive in Milestone 4.')}
      `,
    }));
  });
}
