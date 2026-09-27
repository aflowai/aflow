/**
 * D12 baseline pin authority: the baseline is the ruler, so pin/unpin are
 * operator-only REST — agent principals rejected at the boundary, only a
 * COMPLETED batch of the SAME skill is pinnable (teaching refusals
 * otherwise), repin upserts, unpin is idempotent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { registerEvalBaselineRoutes } from './evalBaseline.js';
import {
  getEvalBaseline,
  getEvalBatchHead,
  pinEvalBaseline,
  unpinEvalBaseline,
} from '@aflow/cybernetic-runtime';

vi.mock('@aflow/cybernetic-runtime', () => ({
  getEvalBaseline: vi.fn(),
  getEvalBatchHead: vi.fn(),
  pinEvalBaseline: vi.fn(),
  unpinEvalBaseline: vi.fn(),
}));

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const SPACE_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_ID = '00000000-0000-4000-8000-0000000000bb';
const BATCH_ID = '00000000-0000-4000-8000-0000000000cf';
const SLUG = 'daily-metrics';

const getBaselineMock = vi.mocked(getEvalBaseline);
const headMock = vi.mocked(getEvalBatchHead);
const pinMock = vi.mocked(pinEvalBaseline);
const unpinMock = vi.mocked(unpinEvalBaseline);

async function buildTestApp(opts: { isServicePrincipal: boolean }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = { db: {} };

  app.addHook('onRequest', async (request) => {
    (request as unknown as { authUser: unknown }).authUser = {
      userId: USER_ID,
      authMethod: 'test',
      isServicePrincipal: opts.isServicePrincipal,
    };
    (request as unknown as { requireTenant: () => Promise<unknown> }).requireTenant = async () => ({
      tenantId: TENANT_ID,
    });
    (request as unknown as { requireSpace: () => Promise<unknown> }).requireSpace = async () => ({
      spaceId: SPACE_ID,
    });
  });

  await app.register(
    // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
    async (scope) => {
      registerEvalBaselineRoutes(scope);
    },
    { prefix: '/v1/spaces' },
  );
  await app.ready();
  return app;
}

const BASELINE_URL = `/v1/spaces/${SPACE_ID}/workflows/${SLUG}/eval-baseline`;
const PINNED_AT = new Date('2026-08-06T00:00:00.000Z');

beforeEach(() => {
  getBaselineMock.mockReset();
  headMock.mockReset();
  pinMock.mockReset();
  unpinMock.mockReset();
});

describe('PUT /:spaceId/workflows/:slug/eval-baseline', () => {
  it('rejects a service-principal caller before any store call', async () => {
    const app = await buildTestApp({ isServicePrincipal: true });
    const response = await app.inject({
      method: 'PUT',
      url: BASELINE_URL,
      payload: { batchId: BATCH_ID },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'operator_only' });
    expect(headMock).not.toHaveBeenCalled();
    expect(pinMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('pins a completed batch of the skill', async () => {
    headMock.mockResolvedValueOnce({
      id: BATCH_ID,
      workflowSlug: SLUG,
      status: 'completed',
    } as never);
    pinMock.mockResolvedValueOnce({
      batchId: BATCH_ID,
      pinnedAt: PINNED_AT,
      pinnedByUserId: USER_ID,
    } as never);
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({
      method: 'PUT',
      url: BASELINE_URL,
      payload: { batchId: BATCH_ID },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      baseline: {
        batchId: BATCH_ID,
        pinnedAt: PINNED_AT.toISOString(),
        pinnedByUserId: USER_ID,
      },
    });
    expect(pinMock).toHaveBeenCalledWith({}, TENANT_ID, {
      spaceId: SPACE_ID,
      workflowSlug: SLUG,
      batchId: BATCH_ID,
      pinnedByUserId: USER_ID,
    });
    await app.close();
  });

  it('404s a batch outside this space', async () => {
    headMock.mockResolvedValueOnce(null);
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({
      method: 'PUT',
      url: BASELINE_URL,
      payload: { batchId: BATCH_ID },
    });
    expect(response.statusCode).toBe(404);
    expect(pinMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('422s a batch of a DIFFERENT skill — a baseline rules the skill it measured', async () => {
    headMock.mockResolvedValueOnce({
      id: BATCH_ID,
      workflowSlug: 'other-skill',
      status: 'completed',
    } as never);
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({
      method: 'PUT',
      url: BASELINE_URL,
      payload: { batchId: BATCH_ID },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'batch_wrong_skill' });
    expect(pinMock).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(['queued', 'running', 'cancelling', 'failed', 'cancelled'] as const)(
    "refuses pinning a '%s' batch with a teaching error",
    async (status) => {
      headMock.mockResolvedValueOnce({ id: BATCH_ID, workflowSlug: SLUG, status } as never);
      const app = await buildTestApp({ isServicePrincipal: false });
      const response = await app.inject({
        method: 'PUT',
        url: BASELINE_URL,
        payload: { batchId: BATCH_ID },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'batch_not_pinnable', status });
      expect(response.json().message).toContain('COMPLETED');
      expect(pinMock).not.toHaveBeenCalled();
      await app.close();
    },
  );
});

describe('DELETE /:spaceId/workflows/:slug/eval-baseline', () => {
  it('rejects a service-principal caller', async () => {
    const app = await buildTestApp({ isServicePrincipal: true });
    const response = await app.inject({ method: 'DELETE', url: BASELINE_URL });
    expect(response.statusCode).toBe(403);
    expect(unpinMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('unpins and reports it', async () => {
    unpinMock.mockResolvedValueOnce(true);
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({ method: 'DELETE', url: BASELINE_URL });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, unpinned: true });
    await app.close();
  });

  it('unpinning an unpinned skill is idempotent (200, unpinned: false)', async () => {
    unpinMock.mockResolvedValueOnce(false);
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({ method: 'DELETE', url: BASELINE_URL });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, unpinned: false });
    await app.close();
  });
});

describe('GET /:spaceId/workflows/:slug/eval-baseline', () => {
  it('reads the pin without an operator gate (reads are for everyone)', async () => {
    getBaselineMock.mockResolvedValueOnce({
      batchId: BATCH_ID,
      pinnedAt: PINNED_AT,
      pinnedByUserId: null,
    } as never);
    const app = await buildTestApp({ isServicePrincipal: true });
    const response = await app.inject({ method: 'GET', url: BASELINE_URL });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      baseline: { batchId: BATCH_ID, pinnedAt: PINNED_AT.toISOString(), pinnedByUserId: null },
    });
    await app.close();
  });

  it('returns null when nothing is pinned', async () => {
    getBaselineMock.mockResolvedValueOnce(null);
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({ method: 'GET', url: BASELINE_URL });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ baseline: null });
    await app.close();
  });
});
