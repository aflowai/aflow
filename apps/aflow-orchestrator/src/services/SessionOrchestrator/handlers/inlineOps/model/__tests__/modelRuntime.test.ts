/**
 * A change Helmsman proposes to the model runtime parks on the operator's
 * approval, runs once for an approval of exactly the request it would make
 * now, and asks again — with the spent decision named — rather than ride an
 * approval it already used.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  grant: null as null | {
    requestHash: string;
    decision: 'approved' | 'denied';
    decidedAt?: string;
  },
  spendable: true,
  applied: [] as unknown[],
  paused: [] as Array<Record<string, unknown>>,
  succeeded: [] as unknown[],
  failed: [] as Array<{ code: string; classification: string }>,
}));

vi.mock('@aflow/database', () => ({ getDatabase: () => ({}) }));
vi.mock('@aflow/redis', () => ({
  countRuntimeRequests: async () => 0,
  getWriteApprovalGrant: async () => m.grant,
  spendWriteApprovalGrant: async () => {
    const first = m.spendable;
    m.spendable = false;
    return first;
  },
}));
vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    localRuntimeChangeRequest: actual.localRuntimeChangeRequest,
    localRoleModels: () => ({ helmsman: 'ollama-gemma4-26b' }),
    readSpaceModelDefaults: async () => undefined,
    resolveSpaceLocalRuntime: async () => ({ runtimeId: 'this-machine:11434' }),
    diagnoseSpaceLocalRuntime: async () => ({
      runtime: { baseUrl: 'http://127.0.0.1:11434', reachable: true, version: '0.40.5' },
      machine: null,
      connection: { contextTokens: null, keepAlive: null, parallel: 1 },
      models: [],
      issues: [],
    }),
    applyLocalModelAction: async (_ctx: unknown, change: unknown) => {
      m.applied.push(change);
      return { ok: true, message: 'Unloaded gemma4:26b.' };
    },
  };
});
vi.mock('../../sessionUser.js', () => ({ sessionUser: async () => 'user-1' }));
vi.mock('../../helpers.js', () => ({
  readInlineOpInput: async () => ({ change: { action: 'unload', model: 'ollama-gemma4-26b' } }),
  emitStepPaused: async (_args: unknown, data: Record<string, unknown>) => {
    m.paused.push(data);
  },
  emitStepSuccess: async (_args: unknown, data: unknown) => {
    m.succeeded.push(data);
  },
  emitStepError: async (
    _args: unknown,
    code: string,
    _msg: string,
    _t: number,
    classification: string,
  ) => {
    m.failed.push({ code, classification });
  },
}));

const { handleModelRuntimeInline } = await import('../index.js');

const args = {
  redis: {},
  context: { tenantId: 't', runId: 'run-1', spaceId: 'space-1' },
  stepDef: { operation: 'model.runtime.change' },
} as never;

beforeEach(() => {
  m.grant = null;
  m.spendable = true;
  m.applied = [];
  m.paused = [];
  m.succeeded = [];
  m.failed = [];
});

describe('model.runtime.change', () => {
  it('parks on the operator’s approval and changes nothing', async () => {
    await handleModelRuntimeInline(args);
    expect(m.applied).toEqual([]);
    expect(m.paused[0]).toMatchObject({
      kind: 'write_approval',
      target: 'local_model',
      change: { action: 'unload' },
      impact: { ownConversationReloads: true },
    });
  });

  it('runs once on an approval of the request it would make now', async () => {
    await handleModelRuntimeInline(args);
    const asked = m.paused[0] as { requestHash: string };
    m.grant = {
      requestHash: asked.requestHash,
      decision: 'approved',
      decidedAt: '2026-10-16T21:00:00Z',
    };
    m.paused = [];

    await handleModelRuntimeInline(args);
    expect(m.applied).toEqual([{ action: 'unload', model: 'ollama-gemma4-26b' }]);
    expect(m.succeeded).toEqual([{ message: 'Unloaded gemma4:26b.' }]);

    await handleModelRuntimeInline(args);
    expect(m.applied).toHaveLength(1);
    expect(m.paused[0]).toMatchObject({ decidedBefore: '2026-10-16T21:00:00Z' });
  });

  it('fails as final on a denial', async () => {
    await handleModelRuntimeInline(args);
    const asked = m.paused[0] as { requestHash: string };
    m.grant = { requestHash: asked.requestHash, decision: 'denied' };
    await handleModelRuntimeInline(args);
    expect(m.failed).toEqual([
      { code: 'MODEL_RUNTIME_CHANGE_DENIED', classification: 'permission' },
    ]);
    expect(m.applied).toEqual([]);
  });
});
