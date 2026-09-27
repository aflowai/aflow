import { describe, expect, it } from 'vitest';

import { classifyRunsByLiveness } from '../skillLifecycle.js';
import type { WorkflowRunDetail, WorkflowTaskRow } from '../scheduling/types.js';
import { SkillTombstoneSchema, skillTombstonePath, type SkillTombstone } from '@aflow/schemas';
import { getOperation } from '@aflow/schemas';

// ============================================================================
// Helpers
// ============================================================================

const FIXED_NOW = new Date('2026-05-06T12:00:00.000Z');
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

interface TaskOverride {
  taskId: string;
  status: string;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

function makeTask(o: TaskOverride): WorkflowTaskRow {
  return {
    id: `task-row-${o.taskId}`,
    runId: 'run-fixture',
    taskId: o.taskId,
    status: o.status,
    attempt: 1,
    sessionId: null,
    workerSessionId: null,
    startedAt: o.startedAt ?? null,
    completedAt: o.completedAt ?? null,
    durationMs: null,
    costCents: null,
    metricsJson: null,
    summary: null,
    failureReason: null,
    outputRef: null,
    reflectionJson: null,
  };
}

interface RunOverride {
  runId: string;
  status?: string;
  startedAt?: Date;
  schedulerCursorAt?: Date | null;
  tasks?: WorkflowTaskRow[];
}

function makeRun(o: RunOverride): WorkflowRunDetail {
  return {
    id: `pk-${o.runId}`,
    spaceId: 'space-fixture',
    workflowSlug: 'fixture-slug',
    runId: o.runId,
    sessionId: null,
    status: o.status ?? 'running',
    workflowRevision: 1,
    startedAt: o.startedAt ?? FIXED_NOW,
    completedAt: null,
    totalCostCents: null,
    totalTokens: null,
    evaluationJson: null,
    failureJson: null,
    learningsJson: null,
    schedulerCursorAt: o.schedulerCursorAt ?? null,
    metadata: {},
    tasks: o.tasks ?? [],
  };
}

// ============================================================================
// classifyRunsByLiveness — the force-archive safety gate
// ============================================================================

describe('classifyRunsByLiveness', () => {
  it('buckets a stalled run as force-cancellable', () => {
    // Run with no live/paused tasks, scheduler cursor older than threshold →
    // deriveRunLiveness returns 'stalled'.
    const stalledStart = new Date(FIXED_NOW.getTime() - 10 * 60 * 1000);
    const run = makeRun({ runId: 'r-stalled', startedAt: stalledStart });
    const result = classifyRunsByLiveness([run], {
      now: FIXED_NOW,
      staleThresholdMs: STALE_THRESHOLD_MS,
    });
    expect(result.stalled).toHaveLength(1);
    expect(result.live).toHaveLength(0);
    expect(result.stalled[0]?.runId).toBe('r-stalled');
    expect(result.stalled[0]?.liveness).toBe('stalled');
  });

  it('refuses to bucket an executing run as force-cancellable', () => {
    // At least one task in 'running' → deriveRunLiveness returns 'executing'.
    const run = makeRun({
      runId: 'r-executing',
      tasks: [makeTask({ taskId: 't1', status: 'running' })],
    });
    const result = classifyRunsByLiveness([run], { now: FIXED_NOW });
    expect(result.stalled).toHaveLength(0);
    expect(result.live).toHaveLength(1);
    expect(result.live[0]?.liveness).toBe('executing');
  });

  it('refuses to bucket a waiting-for-input run as force-cancellable', () => {
    const run = makeRun({
      runId: 'r-waiting',
      tasks: [makeTask({ taskId: 't1', status: 'paused' })],
    });
    const result = classifyRunsByLiveness([run], { now: FIXED_NOW });
    expect(result.stalled).toHaveLength(0);
    expect(result.live).toHaveLength(1);
    expect(result.live[0]?.liveness).toBe('waiting_for_input');
  });

  it('refuses to bucket an idle run as force-cancellable (the subtle case)', () => {
    // Idle = transient pre-dispatch state. False-stalled would cancel a run
    // that's about to do real work. We err toward refusing.
    const run = makeRun({ runId: 'r-idle', startedAt: FIXED_NOW });
    const result = classifyRunsByLiveness([run], {
      now: FIXED_NOW,
      staleThresholdMs: STALE_THRESHOLD_MS,
    });
    expect(result.stalled).toHaveLength(0);
    expect(result.live).toHaveLength(1);
    expect(result.live[0]?.liveness).toBe('idle');
  });

  it('handles a mixed batch — splits stalled vs live correctly', () => {
    const stalledStart = new Date(FIXED_NOW.getTime() - 10 * 60 * 1000);
    const stalled = makeRun({ runId: 'r-stalled', startedAt: stalledStart });
    const executing = makeRun({
      runId: 'r-executing',
      tasks: [makeTask({ taskId: 't1', status: 'running' })],
    });
    const waiting = makeRun({
      runId: 'r-waiting',
      tasks: [makeTask({ taskId: 't1', status: 'paused' })],
    });
    const result = classifyRunsByLiveness([stalled, executing, waiting], {
      now: FIXED_NOW,
      staleThresholdMs: STALE_THRESHOLD_MS,
    });
    expect(result.stalled.map((r) => r.runId)).toEqual(['r-stalled']);
    expect(result.live.map((r) => r.runId).sort()).toEqual(['r-executing', 'r-waiting']);
  });

  it('preserves the deriveRunLiveness reason for operator-facing errors', () => {
    // The lifecycle error includes per-run reasons in `details.liveRuns` so
    // the UI can tell the operator which task is keeping the skill live.
    const run = makeRun({
      runId: 'r-executing',
      tasks: [makeTask({ taskId: 'ingest', status: 'running' })],
    });
    const { live } = classifyRunsByLiveness([run]);
    expect(live[0]?.reason).toMatch(/actively executing/);
    expect(live[0]?.reason).toMatch(/ingest/);
  });

  it('returns empty buckets for an empty input — happy edge case', () => {
    const result = classifyRunsByLiveness([]);
    expect(result.stalled).toEqual([]);
    expect(result.live).toEqual([]);
  });
});

// ============================================================================
// SkillTombstoneSchema — purge breadcrumb shape
// ============================================================================

describe('SkillTombstoneSchema', () => {
  const validTombstone: SkillTombstone = {
    skillId: 'titanic-kaggle-optimizer',
    workflowSlug: 'titanic-kaggle-optimizer',
    name: 'Titanic Kaggle Optimizer',
    origin: 'cloned',
    archivedAt: '2026-05-01T10:00:00.000Z',
    purgedAt: '2026-05-06T12:00:00.000Z',
    purgedByUserId: 'a8b2c3d4-1111-2222-3333-444455556666',
    workflowRevision: 3,
    danglingRunCount: 7,
  };

  it('accepts a fully-populated tombstone round-trip', () => {
    const parsed = SkillTombstoneSchema.parse(validTombstone);
    expect(parsed).toEqual(validTombstone);
  });

  it('accepts a system-purged tombstone (purgedByUserId nullable)', () => {
    const result = SkillTombstoneSchema.safeParse({
      ...validTombstone,
      purgedByUserId: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a tombstone with a non-ISO archivedAt', () => {
    const result = SkillTombstoneSchema.safeParse({
      ...validTombstone,
      archivedAt: 'last tuesday',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a tombstone with negative danglingRunCount', () => {
    const result = SkillTombstoneSchema.safeParse({
      ...validTombstone,
      danglingRunCount: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a tombstone with an unrecognized origin', () => {
    const result = SkillTombstoneSchema.safeParse({
      ...validTombstone,
      origin: 'extraterrestrial',
    });
    expect(result.success).toBe(false);
  });

  it('skillTombstonePath is deterministic and correctly formed', () => {
    expect(skillTombstonePath('foo')).toBe('/skills/foo/tombstone.json');
    expect(skillTombstonePath('skl-with-hyphens')).toBe('/skills/skl-with-hyphens/tombstone.json');
  });
});

// ============================================================================
// Operation registry contract — agent surface boundary
// ============================================================================

describe('skill.manage operation registry', () => {
  // The structural enforcement that keeps destructive ops off the agent
  // tool surface. If `internal: true` regresses, agents can invoke
  // archive/unarchive/purge directly via tool dispatch, bypassing the
  // operator-only HTTP path.

  it('archive is internal: true (agent tool surface excluded)', () => {
    const op = getOperation('skill.manage.archive');
    expect(op).toBeDefined();
    expect(op?.internal).toBe(true);
    expect(op?.accessMode).toBe('write');
    expect(op?.mutates).toBe(true);
  });

  it('unarchive is internal: true', () => {
    const op = getOperation('skill.manage.unarchive');
    expect(op).toBeDefined();
    expect(op?.internal).toBe(true);
    expect(op?.accessMode).toBe('write');
    expect(op?.mutates).toBe(true);
  });

  it('purge is internal: true', () => {
    const op = getOperation('skill.manage.purge');
    expect(op).toBeDefined();
    expect(op?.internal).toBe(true);
    expect(op?.accessMode).toBe('write');
    expect(op?.mutates).toBe(true);
  });

  it('preview is NOT internal (agent-callable, read-only)', () => {
    // The registry stores `internal: false` as `undefined` after normalization;
    // both mean "available to the agent tool surface". The semantic check is
    // truthiness, not strict equality with `false`.
    const op = getOperation('skill.manage.preview');
    expect(op).toBeDefined();
    expect(op?.internal).toBeFalsy();
    expect(op?.accessMode).toBe('read');
    expect(op?.mutates).toBeFalsy();
  });

  it('all four ops share the same capability group (skill.manage)', () => {
    const ops = ['archive', 'unarchive', 'purge', 'preview'].map((v) =>
      getOperation(`skill.manage.${v}`),
    );
    for (const op of ops) {
      expect(op?.stepType).toBe('skill');
      expect(op?.group).toBe('manage');
    }
  });
});
