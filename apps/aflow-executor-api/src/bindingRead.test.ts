import { beforeEach, expect, it, vi } from 'vitest';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from '@aflow/redis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
const { resolve, simulate, live } = vi.hoisted(() => ({
  resolve: vi.fn(),
  simulate: vi.fn(),
  live: vi.fn(),
}));
vi.mock('./handlers/api/resolution.js', () => ({ resolveCall: resolve }));
vi.mock('./handlers/api/simulation/execute.js', () => ({
  executeSimulatedCall: simulate,
  toSimulatedFetchResponse: (answer: { body: unknown; status: number }) =>
    new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    }),
}));
vi.mock('./handlers/api/execution.js', () => ({ executeWithRetry: live, fetchWithRetry: live }));
vi.mock('./handlers/api/writeApprovalGate.js', async (original) => ({
  ...(await original<typeof import('./handlers/api/writeApprovalGate.js')>()),
  enforceWriteApprovalGate: vi.fn(),
}));
import { readBindingEndpoint } from './bindingRead.js';

const data = new Map<string, unknown>();
const deps = {
  db: {} as PostgresJsDatabase,
  redis: {} as Redis,
  payloadStore: {
    store: async ({ data: value }: { data: unknown }) => {
      const key = `inline:${String(data.size)}`;
      data.set(key, value);
      return key;
    },
    retrieve: async (ref: string) => data.get(ref),
  } as unknown as PayloadStore,
  tenantId: '00000000-0000-4000-8000-000000000001',
  spaceId: '00000000-0000-4000-8000-000000000002',
  runId: '00000000-0000-4000-8000-000000000003',
  credentialOwnerId: 'operator',
};
beforeEach(() => {
  vi.clearAllMocks();
  data.clear();
});

it('routes a simulated merge read through the binding simulation without live egress', async () => {
  resolve.mockResolvedValue({
    apiId: 'github',
    endpointId: 'getPullRequest',
    method: 'GET',
    url: 'https://api.github.com/repos/owner/repo/pulls/1',
    headers: {},
    simulation: { bindingId: 'github', simulationId: 'world', apiId: 'github' },
  });
  simulate.mockResolvedValue({ status: 200, body: { merged: true }, rung: 'code' });
  expect(await readBindingEndpoint(deps, 'github', 'getPullRequest', { pull_number: '1' })).toEqual(
    { merged: true },
  );
  expect(simulate).toHaveBeenCalledOnce();
  expect(resolve.mock.calls[0]?.[2]?.job.credentialOwnerId).toBe('operator');
  expect(live).not.toHaveBeenCalled();
});

it('uses the API executor egress path for a live merge read', async () => {
  resolve.mockResolvedValue({
    apiId: 'github',
    endpointId: 'getPullRequest',
    method: 'GET',
    url: 'https://api.github.com/repos/owner/repo/pulls/1',
    headers: {},
    egressPolicy: {},
  });
  live.mockRejectedValue(new Error('Binding egress refused the read'));
  await expect(readBindingEndpoint(deps, 'github', 'getPullRequest', {})).rejects.toThrow(
    'could not attest',
  );
  expect(live).toHaveBeenCalledOnce();
  expect(simulate).not.toHaveBeenCalled();
});

it('throws on GitHub 5xx so a later wake can retry', async () => {
  resolve.mockResolvedValue({
    apiId: 'github',
    endpointId: 'getPullRequest',
    method: 'GET',
    url: 'https://api.github.com/repos/owner/repo/pulls/1',
    headers: {},
    simulation: { bindingId: 'github', simulationId: 'world', apiId: 'github' },
  });
  simulate.mockResolvedValue({ status: 503, body: { message: 'Unavailable' }, rung: 'code' });
  await expect(readBindingEndpoint(deps, 'github', 'getPullRequest', {})).rejects.toThrow();
});
