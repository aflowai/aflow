/**
 * D14 promotion mining: a terminal run's persisted record becomes a draft
 * case — validated inputs → trigger, terminal state → prefilled expectation,
 * memory reads → fixture docs, observed outputs → reference/counterexample
 * provenance — with every unrecoverable piece named in `missing` instead of
 * papered over, and non-terminal/cancelled runs rejected outright.
 */
import { describe, expect, it } from 'vitest';
import { GoldenCaseContentSchema } from '@aflow/schemas';
import {
  buildDraftCaseFromRun,
  extractMemoryReadCandidates,
  extractOtherMemoryReads,
  memoryDocFromOutput,
  type PromotableRunFacts,
  type PromotableTaskFacts,
} from '../goldenCasePromotion.js';

const RUN_ID = 'run_9f3a';

function completedRun(overrides: Partial<PromotableRunFacts> = {}): PromotableRunFacts {
  return {
    runId: RUN_ID,
    workflowSlug: 'daily-metrics',
    status: 'completed',
    workflowRevision: 12,
    metadata: {
      parentTaskInputs: {
        taskId: 'collect',
        inputs: { ticker: 'NVDA', window: 30 },
      },
      parentInstructions: { runLevel: 'Focus on the last 30 days.' },
    },
    ...overrides,
  };
}

const tasks: PromotableTaskFacts[] = [
  {
    taskId: 'collect',
    status: 'succeeded',
    operationId: 'memory.store.get',
    outputRef: 'inline:bWVt',
    completedAtMs: 1_000,
  },
  {
    taskId: 'analyze',
    status: 'succeeded',
    operationId: 'ai.agent.turn',
    outputRef: 'gs://bucket/tenants/t/runs/r/steps/s1/attempt/1/output.json',
    completedAtMs: 2_000,
  },
  {
    taskId: 'report',
    status: 'succeeded',
    operationId: 'ai.agent.turn',
    outputRef: 'gs://bucket/tenants/t/runs/r/steps/s2/attempt/1/output.json',
    completedAtMs: 3_000,
  },
];

describe('buildDraftCaseFromRun', () => {
  it('mines a completed run: inputs, instructions, terminal state, reference output', () => {
    const result = buildDraftCaseFromRun({
      run: completedRun(),
      tasks,
      memoryDocs: [{ path: '/notes/context.md', contentRef: 'inline:ZG9j' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The content is storable as-is (drafts stay schema-valid while incomplete).
    const content = GoldenCaseContentSchema.parse(result.content);
    expect(content.trigger.inputs).toEqual({ ticker: 'NVDA', window: 30 });
    expect(content.trigger.instructions).toBe('Focus on the last 30 days.');
    expect(content.stratum.direction).toBe('should_succeed');
    expect(content.expectations).toEqual([{ kind: 'terminal', runStatus: 'completed' }]);
    expect(content.fixture.tier).toBe('seeded');
    expect(content.fixture.learnings).toBe('none');
    expect(content.fixture.memoryDocs).toEqual([
      { path: '/notes/context.md', contentRef: 'inline:ZG9j' },
    ]);
    expect(content.provenance).toMatchObject({
      source: 'promoted_from_run',
      runId: RUN_ID,
      runStatus: 'completed',
      workflowRevision: 12,
      // The LAST observed output is the reference, judge context only.
      referenceOutputRef: 'gs://bucket/tenants/t/runs/r/steps/s2/attempt/1/output.json',
    });
    expect(content.provenance.counterexample).toBeUndefined();
    expect(result.missing).toEqual([]);
  });

  it('mines a failed run into a counterexample with the failure critique', () => {
    const failedTasks: PromotableTaskFacts[] = [
      ...tasks.slice(0, 2),
      { taskId: 'report', status: 'failed', failureReason: 'fabricated citations' },
    ];
    const result = buildDraftCaseFromRun({
      run: completedRun({ status: 'failed', failureRef: 'inline:ZmFpbA==' }),
      tasks: failedTasks,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.provenance.counterexample).toEqual({
      outputRef: 'inline:ZmFpbA==',
      critique: 'fabricated citations',
    });
    expect(result.content.provenance.referenceOutputRef).toBeUndefined();
    expect(result.content.provenance.runStatus).toBe('failed');
    // Direction defaults to should_succeed: the failure is the counterexample,
    // the expectations get edited by the operator to describe correct behavior.
    expect(result.content.stratum.direction).toBe('should_succeed');
    // No solvability evidence yet (the failed run is the counterexample) —
    // capability tier until a passing run graduates the case.
    expect(result.content.stratum.tier).toBe('capability');
    expect(result.content.expectations).toEqual([{ kind: 'terminal', runStatus: 'failed' }]);
  });

  it('mines a paused run: pausedReason + paused task prefill the terminal expectation', () => {
    const pausedTasks: PromotableTaskFacts[] = [
      ...tasks.slice(0, 1),
      { taskId: 'triage', status: 'paused' },
    ];
    const result = buildDraftCaseFromRun({
      run: completedRun({ status: 'paused', pausedReason: 'needs_decision' }),
      tasks: pausedTasks,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.stratum.direction).toBe('should_pause');
    expect(result.content.expectations).toEqual([
      {
        kind: 'terminal',
        runStatus: 'paused',
        pausedReason: 'needs_decision',
        pausedTaskId: 'triage',
      },
    ]);
  });

  it('an unrecognized pausedReason is omitted and named in missing, not invented', () => {
    const result = buildDraftCaseFromRun({
      run: completedRun({ status: 'paused', pausedReason: 'some_legacy_value' }),
      tasks: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.expectations).toEqual([{ kind: 'terminal', runStatus: 'paused' }]);
    expect(result.missing.some((m) => m.includes('paused reason'))).toBe(true);
  });

  it('missing inputs and unrecoverable memory reads are named, and gaps land in the draft notes', () => {
    const result = buildDraftCaseFromRun({
      run: completedRun({ metadata: {} }),
      tasks,
      memoryGapTaskIds: ['collect'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.trigger.inputs).toEqual({});
    expect(result.missing.some((m) => m.includes('trigger inputs'))).toBe(true);
    expect(result.missing.some((m) => m.includes("memory read of task 'collect'"))).toBe(true);
    expect(result.content.notes).toContain("memory read of task 'collect'");
  });

  it('rejects cancelled and non-terminal runs', () => {
    expect(
      buildDraftCaseFromRun({ run: completedRun({ status: 'cancelled' }), tasks: [] }),
    ).toMatchObject({ ok: false, code: 'run_cancelled' });
    expect(
      buildDraftCaseFromRun({ run: completedRun({ status: 'running' }), tasks: [] }),
    ).toMatchObject({ ok: false, code: 'run_not_terminal' });
  });

  it('threads campaign linkage and config through the trigger', () => {
    const result = buildDraftCaseFromRun({
      run: completedRun({ campaignId: '3b9b3f66-0f6b-4a3d-9a3e-2a8d1c8f4e11' }),
      tasks,
      campaignConfig: { target: 0.9 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.trigger.campaignId).toBe('3b9b3f66-0f6b-4a3d-9a3e-2a8d1c8f4e11');
    expect(result.content.trigger.campaignConfig).toEqual({ target: 0.9 });
  });
});

describe('memory-read mining helpers', () => {
  it('extractMemoryReadCandidates attempts recovery ONLY for plain gets', () => {
    const candidates = extractMemoryReadCandidates([
      ...tasks,
      { taskId: 'skipped-mem', status: 'skipped', operationId: 'memory.store.get' },
      // A succeeded search WITH an output is not a recovery candidate — its
      // result set is not a doc body, and attempting it would record a false
      // "could not be recovered" gap.
      {
        taskId: 'search-mem',
        status: 'succeeded',
        operationId: 'memory.store.query',
        outputRef: 'inline:cQ==',
      },
    ]);
    expect(candidates).toEqual([{ taskId: 'collect', outputRef: 'inline:bWVt' }]);
  });

  it('extractOtherMemoryReads names non-get reads and skips writes', () => {
    const reads = extractOtherMemoryReads([
      ...tasks,
      {
        taskId: 'search-mem',
        status: 'succeeded',
        operationId: 'memory.store.query',
        outputRef: 'inline:cQ==',
      },
      {
        taskId: 'write-mem',
        status: 'succeeded',
        operationId: 'memory.store.put',
        outputRef: 'inline:dw==',
      },
      { taskId: 'failed-mem', status: 'failed', operationId: 'memory.store.query' },
    ]);
    expect(reads).toEqual([{ taskId: 'search-mem', operationId: 'memory.store.query' }]);
  });

  it('non-get reads land as a distinct note, never a recovery gap', () => {
    const result = buildDraftCaseFromRun({
      run: completedRun(),
      tasks,
      otherMemoryReads: [{ taskId: 'search-mem', operationId: 'memory.store.query' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const note = result.missing.find((m) => m.includes('memory.store.query'));
    expect(note).toBeDefined();
    expect(note).not.toContain('could not be recovered');
  });

  it('memoryDocFromOutput recognizes memory.store.get shapes and rejects others', () => {
    expect(memoryDocFromOutput({ stat: { path: '/notes/a.md' }, data: 'hello' })).toEqual({
      path: '/notes/a.md',
      content: 'hello',
    });
    expect(memoryDocFromOutput({ stat: { path: '/notes/b.json' }, dataJson: { k: 1 } })).toEqual({
      path: '/notes/b.json',
      content: '{"k":1}',
    });
    expect(memoryDocFromOutput({ matches: [] })).toBeNull();
    expect(memoryDocFromOutput('nope')).toBeNull();
  });
});
