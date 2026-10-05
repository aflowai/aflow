/**
 * Health check endpoints.
 * These endpoints are public (no auth required).
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  getEngineHealth,
  getOrchestratorHealth,
  getRedisConnection,
  orchestratorAbsentNotice,
  pingRedis,
} from '@aflow/redis';
import { getConnection } from '@aflow/database';

const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'unhealthy']),
  version: z.string(),
  timestamp: z.string().datetime(),
  checks: z.object({
    database: z.enum(['ok', 'error']).optional(),
    redis: z.enum(['ok', 'error']).optional(),
  }),
});

/**
 * Bounded so a hung dependency degrades the answer instead of the endpoint: an
 * unreachable Postgres holds a connection attempt far longer than anything
 * polling this is willing to wait, and a health check that times out reports
 * nothing at all.
 */
const PROBE_TIMEOUT_MS = 2000;

async function within<T>(work: Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          resolve(undefined);
        }, PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function probeDependencies(): Promise<{
  database: 'ok' | 'error';
  redis: 'ok' | 'error';
}> {
  const [database, redis] = await Promise.all([
    within(getConnection()`select 1`).then((rows) => (rows === undefined ? 'error' : 'ok')),
    within(pingRedis(getRedisConnection())).then((alive) => (alive === true ? 'ok' : 'error')),
  ]);
  return { database, redis };
}

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Basic health check
  app.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'Health check',
        description: 'Basic health check endpoint',
        response: {
          200: HealthResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const checks = await probeDependencies();
      reply.send({
        status: Object.values(checks).every((state) => state === 'ok') ? 'ok' : 'degraded',
        version: process.env['npm_package_version'] ?? '0.1.0',
        timestamp: new Date().toISOString(),
        checks,
      });
    },
  );

  // Readiness check (for Kubernetes)
  app.get(
    '/ready',
    {
      schema: {
        tags: ['Health'],
        summary: 'Readiness check',
        description: 'Check if the service is ready to accept traffic',
        response: {
          200: z.object({ ready: z.boolean() }),
          503: z.object({ ready: z.boolean(), reason: z.string() }),
        },
      },
    },
    async (_request, reply) => {
      const checks = await probeDependencies();
      const failed = Object.entries(checks)
        .filter(([, state]) => state !== 'ok')
        .map(([name]) => name);

      if (failed.length === 0) {
        reply.send({ ready: true });
      } else {
        reply.status(503).send({ ready: false, reason: `unreachable: ${failed.join(', ')}` });
      }
    },
  );

  // Liveness check (for Kubernetes)
  app.get(
    '/live',
    {
      schema: {
        tags: ['Health'],
        summary: 'Liveness check',
        description: 'Check if the service is alive',
        response: {
          200: z.object({ alive: z.boolean() }),
        },
      },
    },
    async (_request, reply) => {
      reply.send({ alive: true });
    },
  );

  const OrchestratorHealthSchema = z.object({
    alive: z.boolean(),
    lastHeartbeat: z.string().nullable(),
    heartbeatAgeMs: z.number().nullable(),
  });
  const OrchestratorHealthResponseSchema = OrchestratorHealthSchema.extend({
    notice: z.string().nullable(),
  });

  // Engine health check (orchestrator + executor heartbeats + queue stats)
  const EngineHealthResponseSchema = z.object({
    orchestrator: OrchestratorHealthSchema,
    executors: z.record(
      z.string(),
      z.object({
        alive: z.boolean(),
        lastHeartbeat: z.string().nullable(),
        heartbeatAgeMs: z.number().nullable(),
      }),
    ),
    queues: z.record(
      z.string(),
      z.object({
        streamLen: z.number(),
        pending: z.number(),
        lag: z.number().nullable(),
      }),
    ),
  });

  app.get(
    '/v1/health/engine',
    {
      // Orchestrator/executor heartbeats and stream lag are operational
      // internals, but this route predates auth on the health plugin and is
      // wired into uptime probes; tightening it is tracked separately.
      config: {
        authzExempt: {
          reason: 'Unauthenticated liveness probe — must not require a tenant context.',
        },
      },
      schema: {
        tags: ['Health'],
        summary: 'Engine health check',
        description:
          'Returns liveness status of the flow engine: orchestrator heartbeat and all registered executor heartbeats.',
        response: {
          200: EngineHealthResponseSchema,
          503: z.object({ error: z.string() }),
        },
      },
    },
    async (_request, reply) => {
      const context = fastify.appContext;
      if (!context?.redis) {
        reply.status(503).send({ error: 'Redis not connected' });
        return;
      }

      const health = await getEngineHealth(context.redis);
      reply.send(health);
    },
  );

  // One round trip, so the web app, the MCP server and `yarn start` can ask it
  // as often as they need without the executor scan the engine check makes.
  app.get(
    '/v1/health/orchestrator',
    {
      config: {
        authzExempt: {
          reason:
            'Unauthenticated liveness probe — read before sign-in and by `yarn start`, which holds no credential.',
        },
      },
      schema: {
        tags: ['Health'],
        summary: 'Orchestrator health check',
        description:
          'Whether any orchestrator is alive to consume the control, result and timer streams, when the last one beat, and the notice every surface shows while none is.',
        response: {
          200: OrchestratorHealthResponseSchema,
          503: z.object({ error: z.string() }),
        },
      },
    },
    async (_request, reply) => {
      const { redis } = fastify.appContext;
      if (!redis) {
        reply.status(503).send({ error: 'Redis not connected' });
        return;
      }

      const health = await getOrchestratorHealth(redis);
      reply.send({ ...health, notice: orchestratorAbsentNotice(health) });
    },
  );
};
