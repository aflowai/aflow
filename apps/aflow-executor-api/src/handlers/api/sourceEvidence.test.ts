import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPut = vi.fn();
const mockEnsureParentDirs = vi.fn();

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    createTenantContext: () => ({}),
    createMemoryDocRepository: () => ({ put: mockPut }),
    createMemoryDirRepository: () => ({ ensureParentDirs: mockEnsureParentDirs }),
  };
});

const { writeSourceEvidence } = await import('./sourceEvidence.js');

const db = {} as never;

function params(provenance: 'live' | 'simulated'): Parameters<typeof writeSourceEvidence>[0] {
  return {
    db,
    tenantId: 'tenant-1',
    spaceId: 'space-1',
    runId: 'run-1',
    apiId: 'bnpl',
    bindingId: 'bind_bnpl',
    endpointId: 'getBalance',
    responseStatus: 200,
    provenance,
  };
}

function putArg(): Record<string, unknown> {
  return mockPut.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe('writeSourceEvidence — provenance comes from the call', () => {
  beforeEach(() => {
    mockPut.mockReset().mockResolvedValue(undefined);
    mockEnsureParentDirs.mockReset().mockResolvedValue(undefined);
  });

  it('tags the evidence doc simulated when the call was answered by a simulation', async () => {
    const result = await writeSourceEvidence(params('simulated'));

    expect(result.ok).toBe(true);
    const doc = putArg();
    expect(doc['tags']).toContain('provenance:simulated');
    expect(JSON.parse(doc['inlineContent'] as string)['provenance']).toBe('simulated');
    expect(doc['summary']).toContain('(simulated)');
  });

  it('leaves a live call unmarked', async () => {
    await writeSourceEvidence(params('live'));

    const doc = putArg();
    expect(doc['tags']).not.toContain('provenance:simulated');
    expect(JSON.parse(doc['inlineContent'] as string)['provenance']).toBe('live');
  });
});
