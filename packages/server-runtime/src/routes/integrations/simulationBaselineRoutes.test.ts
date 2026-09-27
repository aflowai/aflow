/**
 * What the baseline routes own is the HTTP contract, not the world logic.
 *
 * The minting rules live in the shared writer and are tested there; these
 * routes decide what reaches it and what a failure looks like coming back. The
 * status mapping is the part worth pinning: a rejected world and a lost race
 * are different answers to the operator — one means fix the payload, the other
 * means re-read and retry — and collapsing both to 400 would tell them to edit
 * something that was never wrong.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { SpaceId, TenantId } from '@aflow/schemas';

const calls = vi.hoisted(() => ({
  seed: [] as unknown[],
  freeze: [] as unknown[],
  restore: [] as unknown[],
  reject: null as { code: string; message: string; kind: string } | null,
  simulationMissing: false,
}));

class FakeRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly kind: string,
  ) {
    super(message);
  }
}

function minted() {
  return {
    baseline: {
      simulationId: 'sim',
      version: 7,
      entityCounts: { purchases: 2 },
      createdAt: new Date('2026-01-01').toISOString(),
    },
  };
}

function maybeReject(): void {
  if (calls.reject) {
    throw new FakeRejected(calls.reject.code, calls.reject.message, calls.reject.kind);
  }
}

vi.mock('@aflow/cybernetic-runtime', () => ({
  SimulationBaselineRejected: FakeRejected,
  SimulationArtifactRejected: class extends Error {},
  SimulationWorldReadError: class extends Error {},
  foldRunWorld: vi.fn(),
  writeSimulationArtifact: vi.fn(),
  seedSimulationBaseline: vi.fn((...args: unknown[]) => {
    calls.seed.push(args);
    maybeReject();
    return Promise.resolve(minted());
  }),
  freezeSimulationBaseline: vi.fn((...args: unknown[]) => {
    calls.freeze.push(args);
    maybeReject();
    return Promise.resolve({ ...minted(), foldedCallCount: 3, worldVersion: 2 });
  }),
  restoreSimulationBaseline: vi.fn((...args: unknown[]) => {
    calls.restore.push(args);
    maybeReject();
    return Promise.resolve(minted());
  }),
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withTenantSchema: vi.fn((_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) => {
      const node: Record<string, unknown> = {};
      for (const key of ['select', 'from', 'where', 'limit', 'orderBy']) {
        node[key] = () => node;
      }
      (node as { then: unknown }).then = (ok: (rows: unknown[]) => unknown) =>
        ok(
          calls.simulationMissing
            ? []
            : [
                {
                  definitionJson: {
                    simulationId: 'sim',
                    name: 'Sim',
                    targets: { sourceKind: 'api', integrationId: 'api' },
                    collections: [],
                  },
                },
              ],
        );
      return fn(node);
    }),
  };
});

vi.mock('./shared.js', () => ({
  getDb: () => ({}) as unknown,
  getRedis: () => ({}) as unknown,
  getPayloadStore: () => ({}) as unknown,
}));

async function buildApp(): Promise<FastifyInstance> {
  const { registerSimulationRoutes } = await import('./simulations.js');
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('requireTenant', function (this: FastifyRequest) {
    return Promise.resolve({
      tenantId: 'a0000000-0000-4000-8000-000000000001' as TenantId,
      tenantRole: 'admin',
      isAdmin: true,
    });
  });
  app.decorateRequest('requireSpace', function (this: FastifyRequest) {
    return Promise.resolve({
      spaceId: 'b0000000-0000-4000-8000-000000000001' as SpaceId,
      spaceRole: 'admin',
      canWrite: true,
      isSpaceAdmin: true,
      ownerId: null,
      memberCount: 1,
    });
  });
  registerSimulationRoutes(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  calls.seed = [];
  calls.freeze = [];
  calls.restore = [];
  calls.reject = null;
  calls.simulationMissing = false;
});

describe('minting a baseline over HTTP', () => {
  it('seeds a world from supplied entities', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/simulations/sim/baselines',
      payload: { entities: { purchases: [{ purchaseId: 'p1' }] }, description: 'two orders' },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().baseline.version).toBe(7);
    expect(calls.seed).toHaveLength(1);
  });

  it('freezes from the version the CALLER saw, never one it resolves itself', async () => {
    // A freeze that read the latest version for itself would promote from
    // whatever landed while the operator was deciding.
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/simulations/sim/baselines/freeze',
      payload: { runId: 'run-1', expectedVersion: 4 },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().foldedCallCount).toBe(3);
    const input = (calls.freeze[0] as unknown[])[3] as { expectedVersion: number; runId: string };
    expect(input).toMatchObject({ runId: 'run-1', expectedVersion: 4 });
  });

  it('restores an earlier version', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/simulations/sim/baselines/restore',
      payload: { fromVersion: 2 },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const input = (calls.restore[0] as unknown[])[2] as { fromVersion: number };
    expect(input.fromVersion).toBe(2);
  });
});

describe('what a refusal looks like', () => {
  it('answers a rejected world with 400, because the payload is what to fix', async () => {
    calls.reject = { code: 'SIMULATION_SEED_REJECTED', message: 'bad rows', kind: 'validation' };
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/simulations/sim/baselines',
      payload: { entities: {} },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('bad rows');
  });

  it('answers a lost race with 409, because re-reading is the move, not editing', async () => {
    calls.reject = {
      code: 'SIMULATION_FREEZE_CONFLICT',
      message: 'already promoted',
      kind: 'conflict',
    };
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/simulations/sim/baselines/freeze',
      payload: { runId: 'run-1', expectedVersion: 4 },
    });
    await app.close();

    expect(res.statusCode).toBe(409);
  });

  it('answers a run with no pinned world with 404', async () => {
    calls.reject = {
      code: 'SIMULATION_RUN_CONTEXT_MISSING',
      message: 'no world',
      kind: 'not_found',
    };
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/simulations/sim/baselines/freeze',
      payload: { runId: 'run-1', expectedVersion: 4 },
    });
    await app.close();

    expect(res.statusCode).toBe(404);
  });

  it('refuses before the writer when the simulation does not exist', async () => {
    calls.simulationMissing = true;
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/simulations/sim/baselines',
      payload: { entities: {} },
    });
    await app.close();

    expect(res.statusCode).toBe(404);
    expect(calls.seed).toHaveLength(0);
  });
});
