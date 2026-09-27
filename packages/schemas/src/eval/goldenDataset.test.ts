import { describe, it, expect } from 'vitest';
import {
  GoldenCaseRevisionSchema,
  resolveDatasetVersion,
  type CaseRevisionInterval,
} from './goldenDataset.js';

function revision(
  revisionId: string,
  caseId: string,
  addedInVersion: number,
  removedInVersion: number | null,
  status: 'draft' | 'active' = 'active',
): CaseRevisionInterval {
  return { revisionId, caseId, addedInVersion, removedInVersion, status };
}

describe('resolveDatasetVersion', () => {
  // Case A added at v1, edited at v3 (A1 closed, A2 opened), removed at v5.
  // Case B added at v2, never touched. Case C is an unratified draft.
  const revisions = [
    revision('a1', 'case-a', 1, 3),
    revision('a2', 'case-a', 3, 5),
    revision('b1', 'case-b', 2, null),
    revision('c1', 'case-c', 4, null, 'draft'),
  ];

  const idsAt = (version: number) =>
    resolveDatasetVersion(revisions, version)
      .map((r) => r.revisionId)
      .sort();

  it('reconstructs every historical version exactly', () => {
    expect(idsAt(0)).toEqual([]);
    expect(idsAt(1)).toEqual(['a1']);
    expect(idsAt(2)).toEqual(['a1', 'b1']);
    expect(idsAt(3)).toEqual(['a2', 'b1']); // edit chain: a1 closed AT v3, a2 live FROM v3
    expect(idsAt(4)).toEqual(['a2', 'b1']);
    expect(idsAt(5)).toEqual(['b1']); // removal: a2 closed at v5
    expect(idsAt(99)).toEqual(['b1']);
  });

  it('never resolves a draft revision', () => {
    expect(idsAt(4)).not.toContain('c1');
  });

  it('preserves the input row type (works on DB rows and schema objects alike)', () => {
    const rows = [{ ...revision('b1', 'case-b', 2, null), extraColumn: 'kept' }];
    const resolved = resolveDatasetVersion(rows, 2);
    expect(resolved[0]?.extraColumn).toBe('kept');
  });

  it('throws on overlapping validity intervals for one case', () => {
    const corrupt = [revision('x1', 'case-x', 1, null), revision('x2', 'case-x', 2, null)];
    expect(() => resolveDatasetVersion(corrupt, 2)).toThrow(/two live revisions/);
    // At v1 only x1 is live — no overlap yet.
    expect(resolveDatasetVersion(corrupt, 1).map((r) => r.revisionId)).toEqual(['x1']);
  });

  it('rejects a non-integer or negative version', () => {
    expect(() => resolveDatasetVersion(revisions, -1)).toThrow(/non-negative integer/);
    expect(() => resolveDatasetVersion(revisions, 1.5)).toThrow(/non-negative integer/);
  });

  it('treats an undefined removedInVersion like null (schema objects omit it)', () => {
    const openEnded: CaseRevisionInterval = {
      revisionId: 'd1',
      caseId: 'case-d',
      addedInVersion: 1,
      status: 'active',
    };
    expect(resolveDatasetVersion([openEnded], 10).map((r) => r.revisionId)).toEqual(['d1']);
  });
});

describe('GoldenCaseRevisionSchema — version invariants per status', () => {
  const CASE_ID = '00000000-0000-4000-8000-0000000000cc';
  const DATASET_ID = '00000000-0000-4000-8000-0000000000d5';
  const baseRevision = {
    revisionId: '00000000-0000-4000-8000-0000000000e1',
    caseId: CASE_ID,
    datasetId: DATASET_ID,
    case: {
      caseId: CASE_ID,
      datasetId: DATASET_ID,
      title: 'Promoted from failed run run_1',
      stratum: { scenario: 'unclassified', direction: 'should_succeed', tier: 'regression' },
      trigger: { inputs: {} },
      fixture: { tier: 'seeded', learnings: 'none' },
      expectations: [{ kind: 'terminal', runStatus: 'failed' }],
      rubrics: [],
      provenance: { source: 'promoted_from_run', runId: 'run_1', workflowRevision: 2 },
    },
  };

  it('a draft promoted into a fresh dataset carries version 0 — the common first interaction', () => {
    const parsed = GoldenCaseRevisionSchema.safeParse({
      ...baseRevision,
      status: 'draft',
      addedInVersion: 0,
    });
    expect(parsed.success).toBe(true);
  });

  it('a draft discarded before the dataset ever bumped closes at version 0', () => {
    const parsed = GoldenCaseRevisionSchema.safeParse({
      ...baseRevision,
      status: 'draft',
      addedInVersion: 0,
      removedInVersion: 0,
    });
    expect(parsed.success).toBe(true);
  });

  it('an active revision must enter at a bumped version — 0 is corruption, not history', () => {
    const parsed = GoldenCaseRevisionSchema.safeParse({
      ...baseRevision,
      status: 'active',
      addedInVersion: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('an active revision must leave at a bumped version too', () => {
    const parsed = GoldenCaseRevisionSchema.safeParse({
      ...baseRevision,
      status: 'active',
      addedInVersion: 1,
      removedInVersion: 0,
    });
    expect(parsed.success).toBe(false);
  });
});
