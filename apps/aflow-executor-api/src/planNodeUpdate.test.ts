import { beforeEach, expect, it, vi } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';

const { update, attest, binding, state } = vi.hoisted(() => ({
  update: vi.fn(),
  attest: vi.fn(),
  binding: vi.fn(),
  state: vi.fn(),
}));
vi.mock('@aflow/redis', () => ({ getSessionState: state }));
vi.mock('@aflow/cybernetic-runtime', async (original) => ({
  restrictedPlanWriteAuthority: (await original<typeof import('@aflow/cybernetic-runtime')>())
    .restrictedPlanWriteAuthority,
  createPlanNodeStore: () => ({}),
  updatePlanNode: update,
  readMergedPullRequest: attest,
}));
vi.mock('./bindingRead.js', () => ({ readBindingEndpoint: binding }));
import { executePlanNodeUpdate } from './planNodeUpdate.js';

const nodeId = '00000000-0000-4000-8000-000000000331';
const deps = { db: {} as PostgresJsDatabase, redis: {} as Redis, payloadStore: {} as PayloadStore };
const writePayload = vi.fn().mockResolvedValue('inline:e30=');
const ctx = {
  tenantId: 'tenant',
  runId: 'session',
  spaceId: 'space',
  job: { inputRef: 'inline:e30=', credentialOwnerId: 'person' },
  readPayload: async () => ({ nodeId, expectedRevision: 1, status: 'done', outcome: 'Met' }),
  writePayload,
} as unknown as ExecutorContext;
beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue({ trigger: 'schedule', planResident: true });
});
it.each([true, false])(
  'reads the platform publication and GitHub for scheduled marker %s',
  async (planResident) => {
    state.mockResolvedValue({ trigger: 'schedule', planResident });
    attest.mockImplementation(async (_db, _tenant, _space, _url, _node, readers) => {
      await readers.readBinding('github', 'getPullRequest', { pull_number: '1' });
      return { merged: true, evidence: '', reason: '' };
    });
    update.mockImplementation(async (context) => {
      expect(context.resident).toBe(true);
      expect(
        await context.readMergedPullRequest('https://github.com/o/r/pull/1', nodeId),
      ).toMatchObject({ merged: true });
      return { ok: true, node: { nodeId } };
    });
    expect(await executePlanNodeUpdate(ctx, deps)).toMatchObject({ status: 'SUCCEEDED' });
    expect(binding).toHaveBeenCalledWith(
      expect.objectContaining({
        ...deps,
        tenantId: 'tenant',
        spaceId: 'space',
        runId: 'session',
        credentialOwnerId: 'person',
      }),
      'github',
      'getPullRequest',
      { pull_number: '1' },
    );
  },
);
it('reports attestation failures as retryable step errors', async () => {
  update.mockResolvedValue({
    ok: false,
    code: 'PLAN_NODE_ATTESTATION_UNAVAILABLE',
    message: 'Retry on a later wake',
  });
  expect(await executePlanNodeUpdate(ctx, deps)).toMatchObject({
    status: 'FAILED',
    error: { code: 'PLAN_NODE_ATTESTATION_UNAVAILABLE', retryable: true },
  });
});
