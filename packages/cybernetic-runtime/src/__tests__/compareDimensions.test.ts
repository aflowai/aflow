import { describe, it, expect } from 'vitest';
import {
  EvalBatchProvenanceManifestSchema,
  type EvalBatchCompareSide,
  type EvalBatchProvenanceManifest,
} from '@aflow/schemas';

import { compareEvalBatches } from '../evalBatchCompare.js';

const manifest = (over: Record<string, unknown> = {}): EvalBatchProvenanceManifest =>
  EvalBatchProvenanceManifestSchema.parse({
    workflow: { slug: 'cs-desk', revision: 1, configHash: 'cfg-1' },
    dataset: { datasetId: '00000000-0000-4000-8000-000000000001', datasetVersion: 1 },
    graderVersion: 'grader-1',
    ...over,
  });

const side = (over: Partial<EvalBatchCompareSide> = {}): EvalBatchCompareSide => ({
  batchId: '00000000-0000-4000-8000-00000000000a',
  datasetVersion: 1,
  workflowRevision: 1,
  trialsPerCase: 3,
  status: 'completed',
  manifest: manifest(),
  ...over,
});

const dims = (a: EvalBatchCompareSide, b: EvalBatchCompareSide) =>
  new Map(
    compareEvalBatches({
      batchA: a,
      batchB: { ...b, batchId: '00000000-0000-4000-8000-00000000000b' },
      memberRevisionIdsA: [],
      memberRevisionIdsB: [],
      trialRowsA: [],
      trialRowsB: [],
      caseMetaByRevisionId: new Map(),
    }).changedDimensions.map((d) => [d.dimension, d]),
  );

describe('comparison names what changed before any delta', () => {
  it('reports an API contract change — the experiment this product is for', () => {
    const d = dims(
      side({ manifest: manifest({ apiContractHash: 'api-1' }) }),
      side({ manifest: manifest({ apiContractHash: 'api-2' }) }),
    );
    expect(d.get('api_contract')?.status).toBe('changed');
    expect(d.get('api_contract')?.detail).toContain('descriptions');
  });

  it('says a world moved without claiming to know which handler', () => {
    const sealed = { 'case-a/sim-1': { simulationRevision: 1, baselineVersion: 1 } };
    const moved = { 'case-a/sim-1': { simulationRevision: 2, baselineVersion: 1 } };
    const d = dims(
      side({ manifest: manifest({ sealedSources: sealed }) }),
      side({ manifest: manifest({ sealedSources: moved }) }),
    );
    expect(d.get('simulated_world')?.status).toBe('changed');
    expect(d.get('simulated_world')?.detail).toContain('not recoverable');
  });

  it('will not call a world unchanged when a code handler could have moved it', () => {
    // Handlers live in a deployed package, not in the simulation row, so a
    // rewritten handler leaves simulationRevision untouched. Reporting `same`
    // would assert the world held still while its behaviour was rewritten.
    const sealed = { 'case-a/sim-1': { simulationRevision: 1, baselineVersion: 1 } };
    const d = dims(
      side({ manifest: manifest({ sealedSources: sealed }) }),
      side({ manifest: manifest({ sealedSources: sealed }) }),
    );
    expect(d.get('simulated_world')?.status).toBe('unknown');
    expect(d.get('simulated_world')?.detail).toContain('code-rung handler');
  });

  it('calls a world the same only when the build matches too', () => {
    const sealed = { 'case-a/sim-1': { simulationRevision: 1, baselineVersion: 1 } };
    const withBuild = manifest({ sealedSources: sealed, platform: { buildVersion: 'abc123' } });
    const d = dims(side({ manifest: withBuild }), side({ manifest: withBuild }));
    expect(d.get('simulated_world')?.status).toBe('same');
  });

  it('treats an unrecorded dimension as unknown, never as unchanged', () => {
    const d = dims(side(), side());
    expect(d.get('api_contract')?.status).toBe('unknown');
    expect(d.get('agent_version')?.status).toBe('unknown');
  });

  it('marks everything unknown when a side recorded no manifest at all', () => {
    const bare = side();
    delete (bare as { manifest?: unknown }).manifest;
    const d = dims(bare, side());
    expect(d.get('grader')?.status).toBe('unknown');
    expect(d.get('subject_graph')?.status).toBe('unknown');
  });

  it('withholds attribution when more than one dimension moved', () => {
    const result = compareEvalBatches({
      batchA: side({ manifest: manifest({ apiContractHash: 'api-1' }) }),
      batchB: {
        ...side({
          batchId: '00000000-0000-4000-8000-00000000000b',
          manifest: manifest({ apiContractHash: 'api-2', graderVersion: 'grader-2' }),
        }),
      },
      memberRevisionIdsA: [],
      memberRevisionIdsB: [],
      trialRowsA: [],
      trialRowsB: [],
      caseMetaByRevisionId: new Map(),
    });
    expect(result.uncertaintyNote).toContain('cannot be attributed');
  });

  it('reports a dataset change even with no manifests', () => {
    const d = dims(side({ datasetVersion: 1 }), side({ datasetVersion: 2 }));
    expect(d.get('dataset')?.status).toBe('changed');
  });
});
