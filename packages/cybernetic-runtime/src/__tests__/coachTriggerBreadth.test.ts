import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { CoachBreadthEvidenceSchema, type Campaign, type CandidateLearning } from '@aflow/schemas';
import {
  buildCaseDistribution,
  buildTrajectoryEvidence,
  formatBreadthEvidenceForPrompt,
} from '../coachTriggerBreadth.js';

function campaign(): Campaign {
  return {
    campaignId: randomUUID(),
    spaceId: randomUUID(),
    workflowSlug: 'kaggle-competition-optimizer',
    goalRef: 'kaggle-competition-optimizer:numeric:lbValue:maximize',
    scoreMetricKey: 'lbValue',
    direction: 'maximize',
    status: 'active',
    startedAt: new Date().toISOString(),
  };
}

function candidate(observation: string, status: CandidateLearning['status']): CandidateLearning {
  return {
    entryId: randomUUID(),
    campaignId: randomUUID(),
    runId: randomUUID(),
    learning: {
      id: 'l1',
      category: 'strategy_effective',
      kind: 'search_heuristic',
      observation,
      evidence: { runIds: [] },
      confidence: 'medium',
      source: 'runner',
    },
    status,
    createdAt: new Date().toISOString(),
  } as CandidateLearning;
}

describe('buildTrajectoryEvidence (pure, optimization)', () => {
  it('carries objective + series + peak-by-direction + compact learnings history', () => {
    const evidence = buildTrajectoryEvidence({
      campaign: campaign(),
      series: [0.71, 0.74, 0.78, 0.75, 0.73],
      candidates: [
        candidate('shrink CV-LB gap', 'reviewed-rejected'),
        candidate('feature crosses help', 'pending'),
      ],
      goalThreshold: 0.8,
      learningsLimit: 10,
    });
    expect(evidence.objective).toEqual({
      metricKey: 'lbValue',
      direction: 'maximize',
      threshold: 0.8,
    });
    expect(evidence.series).toEqual([0.71, 0.74, 0.78, 0.75, 0.73]);
    expect(evidence.peak).toBe(0.78); // best-by-direction, NOT the latest
    // Newest first; statuses preserved (rejected = negative evidence).
    expect(evidence.learnings.map((l) => l.statement)).toEqual([
      'feature crosses help',
      'shrink CV-LB gap',
    ]);
    expect(evidence.learnings[1]?.status).toBe('reviewed-rejected');
  });

  it('minimize direction → peak is the minimum', () => {
    const evidence = buildTrajectoryEvidence({
      campaign: { ...campaign(), direction: 'minimize' },
      series: [0.4, 0.31, 0.35],
      candidates: [],
      learningsLimit: 10,
    });
    expect(evidence.peak).toBe(0.31);
  });

  it('learningsLimit caps the history (named knob)', () => {
    const evidence = buildTrajectoryEvidence({
      campaign: campaign(),
      series: [1],
      candidates: [candidate('a', 'pending'), candidate('b', 'pending'), candidate('c', 'pending')],
      learningsLimit: 2,
    });
    expect(evidence.learnings).toHaveLength(2);
    expect(evidence.learnings.map((l) => l.statement)).toEqual(['c', 'b']);
  });

  it('parses as the typed optimization member of the union', () => {
    const evidence = buildTrajectoryEvidence({
      campaign: campaign(),
      series: [0.5],
      candidates: [],
      learningsLimit: 5,
    });
    const parsed = CoachBreadthEvidenceSchema.parse({ mode: 'optimization', trajectory: evidence });
    expect(parsed.mode).toBe('optimization');
  });
});

describe('buildCaseDistribution (pure, process — 183f §3 stub depth)', () => {
  it('per-input-class pass rate from eval verdicts, run status as fallback', () => {
    const dist = buildCaseDistribution(
      [
        { runId: 'r1', status: 'completed', evalVerdict: 'pass' },
        { runId: 'r2', status: 'completed', evalVerdict: 'partial' }, // partial ≠ goal acceptance
        { runId: 'r3', status: 'failed' }, // no eval → status
        { runId: 'r4', status: 'completed' }, // no eval → status
        { runId: 'r5', status: 'completed', evalVerdict: 'pass', inputClass: 'large-input' },
      ],
      [],
    );
    expect(dist.sampleSize).toBe(5);
    const byClass = new Map(dist.classes.map((c) => [c.inputClass, c]));
    expect(byClass.get('default')?.runs).toBe(4);
    expect(byClass.get('default')?.passRate).toBe(0.5); // r1 + r4 of 4
    expect(byClass.get('large-input')?.passRate).toBe(1);
  });

  it('failure-mode clustering on taskId[:errorCode] is deterministic', () => {
    const dist = buildCaseDistribution(
      [
        { runId: 'r1', status: 'failed' },
        { runId: 'r2', status: 'failed' },
        { runId: 'r3', status: 'failed' },
      ],
      [
        { runId: 'r1', taskId: 'render-card', errorCode: 'SCHEMA_MISMATCH' },
        { runId: 'r2', taskId: 'render-card', errorCode: 'SCHEMA_MISMATCH' },
        { runId: 'r3', taskId: 'hydrate-state' },
      ],
    );
    expect(dist.failureModes[0]).toEqual({ category: 'render-card:SCHEMA_MISMATCH', count: 2 });
    expect(dist.failureModes[1]).toEqual({ category: 'hydrate-state', count: 1 });
  });

  it('parses as the typed process member of the union', () => {
    const dist = buildCaseDistribution([{ runId: 'r1', status: 'completed' }], []);
    const parsed = CoachBreadthEvidenceSchema.parse({ mode: 'process', caseDistribution: dist });
    expect(parsed.mode).toBe('process');
  });

  it('empty inputs → empty distribution (graceful omission is the caller contract)', () => {
    const dist = buildCaseDistribution([], []);
    expect(dist.sampleSize).toBe(0);
    expect(dist.classes).toEqual([]);
    expect(dist.failureModes).toEqual([]);
  });
});

describe('formatBreadthEvidenceForPrompt', () => {
  it('renders the trajectory with the objective + peak', () => {
    const block = formatBreadthEvidenceForPrompt({
      mode: 'optimization',
      trajectory: buildTrajectoryEvidence({
        campaign: campaign(),
        series: [0.71, 0.78, 0.73],
        candidates: [candidate('bad heuristic', 'reviewed-rejected')],
        learningsLimit: 5,
      }),
    });
    expect(block).toContain('maximize lbValue');
    expect(block).toContain('peak (best-by-direction): 0.78');
    expect(block).toContain('[reviewed-rejected] (search_heuristic) bad heuristic');
  });

  it('renders the case distribution with pass rates + failure modes', () => {
    const block = formatBreadthEvidenceForPrompt({
      mode: 'process',
      caseDistribution: buildCaseDistribution(
        [
          { runId: 'r1', status: 'completed', evalVerdict: 'pass' },
          { runId: 'r2', status: 'failed' },
        ],
        [{ runId: 'r2', taskId: 'render-card' }],
      ),
    });
    expect(block).toContain('last 2 runs');
    expect(block).toContain('class "default": 2 run(s), pass rate 50%');
    expect(block).toContain('render-card × 1');
  });
});
