/**
 * `GET /v1/health/orchestrator`: the one question the web app, the MCP server
 * and `yarn start` all ask — is anything consuming the streams — answered with
 * the notice they show while nothing is.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getOrchestratorHealth: vi.fn() }));

vi.mock('@aflow/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/redis')>();
  return { ...actual, getOrchestratorHealth: mocks.getOrchestratorHealth };
});

const { ORCHESTRATOR_ABSENT_NOTICE } = await import('@aflow/redis');
const { healthRoutes } = await import('./health.js');

let app: FastifyInstance | undefined;

async function serve(redis: unknown): Promise<FastifyInstance> {
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = { redis };
  await app.register(healthRoutes, { prefix: '/' });
  await app.ready();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  mocks.getOrchestratorHealth.mockReset();
});

describe('GET /v1/health/orchestrator', () => {
  it('says nothing while an orchestrator is alive', async () => {
    mocks.getOrchestratorHealth.mockResolvedValue({
      alive: true,
      lastHeartbeat: '2026-10-05T12:00:00.000Z',
      heartbeatAgeMs: 4000,
    });
    const response = await (await serve({})).inject({ url: '/v1/health/orchestrator' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      alive: true,
      lastHeartbeat: '2026-10-05T12:00:00.000Z',
      heartbeatAgeMs: 4000,
      notice: null,
    });
  });

  it('carries the notice, and the last beat, once none is', async () => {
    mocks.getOrchestratorHealth.mockResolvedValue({
      alive: false,
      lastHeartbeat: '2026-10-05T11:20:00.000Z',
      heartbeatAgeMs: 2_400_000,
    });
    const response = await (await serve({})).inject({ url: '/v1/health/orchestrator' });

    expect(response.json()).toMatchObject({
      alive: false,
      lastHeartbeat: '2026-10-05T11:20:00.000Z',
      notice: ORCHESTRATOR_ABSENT_NOTICE,
    });
  });

  it('answers 503 without a Redis to read the leases from', async () => {
    const response = await (await serve(null)).inject({ url: '/v1/health/orchestrator' });

    expect(response.statusCode).toBe(503);
    expect(mocks.getOrchestratorHealth).not.toHaveBeenCalled();
  });
});
