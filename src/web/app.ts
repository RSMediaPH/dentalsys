// Fastify application: security headers, sessions, CSRF, error handling, routes.
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import formbody from '@fastify/formbody';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import fstatic from '@fastify/static';
import { APP_VERSION, PROJECT_ROOT, SYNC_PROTOCOL_VERSION, type Config } from '../config.js';
import { schemaVersion, type DB } from '../db/db.js';
import { loadSession, type SessionRow } from '../auth/auth.js';
import type { Ctx } from '../domain/context.js';
import { syncStatus } from '../domain/outbox.js';
import { AppError, html, randomToken } from '../lib/core.js';
import { page, setDemoBanner } from './ui.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerPatientRoutes } from './routes/patients.js';
import { registerAppointmentRoutes } from './routes/appointments.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerReportAndAdminRoutes } from './routes/admin.js';

export const SESSION_COOKIE = 'dentalsys_session';
export const PRELOGIN_COOKIE = 'dentalsys_prelogin';

declare module 'fastify' {
  interface FastifyRequest {
    auth: { ctx: Ctx; session: SessionRow; token: string } | null;
  }
}

export interface Deps { db: DB; cfg: Config }
export type Form = Record<string, string>;

export function formOf(req: FastifyRequest): Form {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const out: Form = {};
  for (const [k, v] of Object.entries(b)) out[k] = Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
  return out;
}
export const queryOf = (req: FastifyRequest): Form => formOf({ body: req.query } as FastifyRequest);

export function sendPage(reply: FastifyReply, htmlText: string, status = 200): FastifyReply {
  return reply.code(status).type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(htmlText);
}

/** Resolve the signed-in context or redirect to login. */
export function requireAuth(req: FastifyRequest, reply: FastifyReply): { ctx: Ctx; csrf: string; token: string } | null {
  if (!req.auth) {
    void reply.redirect(`/login?next=${encodeURIComponent(req.url.startsWith('/') ? req.url : '/')}`);
    return null;
  }
  return { ctx: req.auth.ctx, csrf: req.auth.session.csrf_token, token: req.auth.token };
}

const MESSAGES: Record<string, string> = {
  patient_created: 'Patient registered.',
  patient_saved: 'Patient details saved.',
  appointment_booked: 'Appointment booked.',
  appointment_updated: 'Appointment updated.',
  invoice_issued: 'Invoice issued.',
  invoice_voided: 'Invoice voided.',
  line_added: 'Line added.',
  line_removed: 'Line removed.',
  discount_saved: 'Discount saved.',
  payment_recorded: 'Payment recorded.',
  payment_duplicate: 'This payment was already recorded (duplicate submission ignored).',
  payment_reversed: 'Payment reversed.',
  branch_switched: 'Branch switched.',
  backup_done: 'Backup completed and verified.',
  draft_deleted: 'Draft invoice deleted.',
};
export const flashFromQuery = (req: FastifyRequest) => {
  const m = queryOf(req).msg;
  return m && MESSAGES[m] ? { kind: 'ok' as const, text: MESSAGES[m]! } : null;
};

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const { db, cfg } = deps;
  setDemoBanner(cfg.demoMode);
  const https = cfg.tlsCertFile && cfg.tlsKeyFile
    ? { key: fs.readFileSync(cfg.tlsKeyFile), cert: fs.readFileSync(cfg.tlsCertFile) }
    : null;
  const app = Fastify({
    ...(https ? { https } : {}),
    // Trust exactly one proxy hop (the hosting platform), so clients cannot spoof their IP via X-Forwarded-For.
    trustProxy: cfg.trustProxy ? (_addr: string, hop: number) => hop < 1 : false,
    bodyLimit: 256 * 1024,
    logger: opts.logger === false ? false : {
      level: 'info',
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      // Never log query strings: they may contain patient search terms.
      serializers: { req: (r: FastifyRequest) => ({ method: r.method, path: r.url.split('?')[0], ip: r.ip }) },
    },
  }) as unknown as FastifyInstance;

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
        formAction: ["'self'"], frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'self'"],
        upgradeInsecureRequests: https || cfg.cookieSecure ? [] : null,
      },
    },
    // HSTS when served over HTTPS directly or behind a TLS-terminating host (COOKIE_SECURE=true).
    hsts: https || cfg.cookieSecure ? { maxAge: 15552000 } : false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(formbody);
  await app.register(fstatic, { root: path.join(PROJECT_ROOT, 'public'), prefix: '/static/', maxAge: '1h' });

  app.decorateRequest('auth', null);
  if (cfg.demoMode) app.addHook('onSend', async (_req, reply) => { reply.header('X-Robots-Tag', 'noindex, nofollow'); });

  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    const loaded = loadSession(db, cfg, token, req.ip);
    req.auth = loaded && token ? { ...loaded, token } : null;
  });

  // CSRF: every state-changing request must carry the session's token (or the pre-login token),
  // and any Origin header must match this server.
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    if (req.url === '/logout' && !req.auth) return; // nothing to protect; just clear the cookie
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let host = '';
      try { host = new URL(origin).host; } catch { /* invalid */ }
      if (host !== req.headers.host) return reply.code(403).type('text/plain').send('Cross-origin request blocked.');
    }
    const sent = formOf(req)._csrf ?? '';
    const expected = req.auth ? req.auth.session.csrf_token : req.cookies[PRELOGIN_COOKIE];
    if (!expected || sent !== expected) {
      return sendPage(reply, page({ title: 'Form expired', body: html`<h1>This form has expired</h1><p>For your security, please go back, reload the page and try again.</p><p><a href="/">Go to start</a></p>` }), 403);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    const ctx = req.auth?.ctx ?? null;
    const csrf = req.auth?.session.csrf_token;
    if (err instanceof AppError) {
      const title = err.status === 404 ? 'Not found' : err.status === 403 ? 'Not permitted' : 'Cannot complete this action';
      return sendPage(reply, page({ title, ctx, csrf, body: html`<h1>${title}</h1><p>${err.message}</p><p><a href="/" data-back>Go back</a> · <a href="/">Start page</a></p>` }), err.status);
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) {
      return sendPage(reply, page({ title: 'Request problem', ctx, csrf, body: html`<h1>Request problem</h1><p>${(err as Error).message}</p>` }), status);
    }
    req.log.error({ err: { message: (err as Error).message, stack: (err as Error).stack } }, 'unhandled error');
    return sendPage(reply, page({ title: 'Something went wrong', ctx, csrf, body: html`<h1>Something went wrong</h1><p>Nothing was saved from the last action. Please try again. If it keeps happening, note the time and contact support.</p>` }), 500);
  });

  app.setNotFoundHandler((req, reply) =>
    sendPage(reply, page({ title: 'Not found', ctx: req.auth?.ctx, csrf: req.auth?.session.csrf_token, body: html`<h1>Page not found</h1><p><a href="/">Go to start</a></p>` }), 404),
  );

  // Health (unauthenticated, no data) and status (authenticated) endpoints.
  app.get('/health', async () => ({ ok: true, app_version: APP_VERSION }));
  app.get('/api/status', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'not_signed_in' });
    const s = syncStatus(db);
    return {
      server: 'ok',
      server_time: new Date().toISOString(),
      app_version: APP_VERSION,
      schema_version: schemaVersion(db),
      sync_protocol_version: SYNC_PROTOCOL_VERSION,
      cloud: { configured: s.cloudConfigured, state: s.cloudConfigured ? 'unknown' : 'not_configured' },
      sync: { pending: s.pending, failed: s.failed, last_success_at: s.lastSuccessAt },
    };
  });

  registerAuthRoutes(app, deps);
  registerPatientRoutes(app, deps);
  registerAppointmentRoutes(app, deps);
  registerBillingRoutes(app, deps);
  registerReportAndAdminRoutes(app, deps);
  return app;
}

export const newPreloginToken = () => randomToken(18);
