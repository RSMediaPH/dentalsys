// Cloud coordination HTTP API. Branch servers connect OUT to this; it never connects into a clinic.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import { APP_VERSION } from '../config.js';
import { MAX_UPLOAD_BATCH, PROTOCOL_HEADER, SUPPORTED_PROTOCOLS, type EnrollRequest, type WireEvent } from '../sync/protocol.js';
import type { Sql } from './sql.js';
import { authenticateNode, CloudError, enroll, getChanges, ingestEvents } from './store.js';

export async function buildCloudApp(sql: Sql, opts: { logger?: boolean; trustProxy?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: opts.trustProxy ? (_a: string, hop: number) => hop < 1 : false,
    logger: opts.logger === false ? false : {
      level: 'info',
      redact: ['req.headers.authorization'],
      serializers: { req: (r: FastifyRequest) => ({ method: r.method, path: r.url.split('?')[0], ip: r.ip }) },
    },
  }) as unknown as FastifyInstance;
  await app.register(helmet, { contentSecurityPolicy: false });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof CloudError) return reply.code(err.status).send({ error: err.code, message: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err: { message: (err as Error).message } }, 'cloud error');
    return reply.code(status).send({ error: status >= 500 ? 'internal_error' : 'bad_request' });
  });

  // Unsupported protocol versions fail clearly and safely: nothing is read or written.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/sync/')) return;
    const v = Number(req.headers[PROTOCOL_HEADER]);
    if (!(SUPPORTED_PROTOCOLS as readonly number[]).includes(v)) {
      return reply.code(426).send({ error: 'unsupported_protocol', supported: SUPPORTED_PROTOCOLS, message: 'Update DentalSys on this clinic server to continue synchronizing.' });
    }
  });

  const node = (req: FastifyRequest) => authenticateNode(sql, req.headers.authorization, String(req.headers['x-dentalsys-app-version'] ?? '') || undefined);

  app.get('/health', async () => ({ ok: true, service: 'dentalsys-cloud', app_version: APP_VERSION }));

  app.post('/sync/v1/enroll', async (req) => enroll(sql, (req.body ?? {}) as EnrollRequest));

  app.post('/sync/v1/events', async (req: FastifyRequest, reply: FastifyReply) => {
    const n = await node(req);
    const events = ((req.body ?? {}) as { events?: WireEvent[] }).events;
    if (!Array.isArray(events) || events.length > MAX_UPLOAD_BATCH) return reply.code(400).send({ error: 'bad_batch' });
    return { results: await ingestEvents(sql, n, events) };
  });

  app.get('/sync/v1/changes', async (req) => {
    const n = await node(req);
    const q = req.query as { after?: string; limit?: string };
    return getChanges(sql, n, q.after ?? '0', Number(q.limit ?? 500));
  });

  return app;
}
