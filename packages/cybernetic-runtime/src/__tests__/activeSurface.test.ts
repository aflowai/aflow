import { describe, it, expect } from 'vitest';
import {
  classifyGraphFidelity,
  normalizeTaskStatus,
  buildRecentTransitions,
  extractTriggerSource,
  computeActiveSurfaceVersion,
} from '../activeSurface.js';
import type { ActiveSurfaceRun, ActiveSurfaceSnapshot, EntityEventEnvelope } from '@aflow/schemas';

// ============================================================================
// classifyGraphFidelity
// ============================================================================

describe('classifyGraphFidelity', () => {
  it('returns full when current ⊇ recorded', () => {
    expect(classifyGraphFidelity(['a', 'b'], ['a', 'b', 'c'])).toBe('full');
  });

  it('returns full when current === recorded', () => {
    expect(classifyGraphFidelity(['a', 'b'], ['a', 'b'])).toBe('full');
  });

  it('returns degraded when a recorded id is missing from current', () => {
    expect(classifyGraphFidelity(['a', 'b', 'x'], ['a', 'b', 'c'])).toBe('degraded');
  });

  it('returns degraded when current is empty (no workflow loaded)', () => {
    expect(classifyGraphFidelity(['a'], [])).toBe('degraded');
  });

  it('returns full when nothing has executed yet but a workflow exists', () => {
    // A run that just started and has no recorded tasks is rendered as the
    // forward DAG with nothing lit — that's the cleanest answer to "where am
    // I in the DAG?" before any tasks materialize.
    expect(classifyGraphFidelity([], ['a', 'b', 'c'])).toBe('full');
  });

  it('returns degraded when neither side has tasks', () => {
    expect(classifyGraphFidelity([], [])).toBe('degraded');
  });
});

// ============================================================================
// normalizeTaskStatus
// ============================================================================

describe('normalizeTaskStatus', () => {
  it('passes known wire statuses through', () => {
    for (const s of [
      'scheduled',
      'claimed',
      'in_flight',
      'running',
      'paused',
      'blocked',
      'failed',
      'succeeded',
      'skipped',
    ]) {
      expect(normalizeTaskStatus(s)).toBe(s);
    }
  });

  it('surfaces unknown statuses as `unknown` instead of masking them as scheduled', () => {
    expect(normalizeTaskStatus('not_a_real_status')).toBe('unknown');
    expect(normalizeTaskStatus('')).toBe('unknown');
  });
});

// ============================================================================
// buildRecentTransitions
// ============================================================================

function makeEvent(
  type: EntityEventEnvelope['eventType'],
  overrides: Partial<EntityEventEnvelope> = {},
): EntityEventEnvelope {
  return {
    eventId: '00000000-0000-4000-8000-000000000000',
    eventType: type,
    spaceId: '00000000-0000-4000-8000-000000000001',
    tenantId: 'tenant-1',
    timestamp: 1_700_000_000_000,
    payload: {},
    summary: 'summary',
    ...overrides,
  };
}

describe('buildRecentTransitions', () => {
  it('captures mode / activation / completion / coach review events', () => {
    const events: EntityEventEnvelope[] = [
      makeEvent('entity.mode.transition', { operatingMode: 'procedural' }),
      makeEvent('entity.procedure.activated', { workflowSlug: 'weekly-roundup' }),
      makeEvent('entity.procedure.completed', { workflowSlug: 'weekly-roundup' }),
      makeEvent('entity.coach.activated', { summary: 'review weekly-roundup run' }),
    ];
    const out = buildRecentTransitions(events);
    expect(out).toHaveLength(4);
    expect(out.map((t) => t.kind)).toEqual([
      'mode',
      'skill_activation',
      'skill_completion',
      'coach_review',
    ]);
    expect(out[0]!.label).toBe('procedural');
    expect(out[1]!.label).toBe('weekly-roundup');
  });

  it('skips event types that are not transitions', () => {
    const events = [
      makeEvent('entity.runner.dispatched'),
      makeEvent('entity.coach.proposal'),
      makeEvent('entity.binding.ratified'),
    ];
    expect(buildRecentTransitions(events)).toEqual([]);
  });

  it('caps the result at 5 entries', () => {
    const events = Array.from({ length: 10 }, () =>
      makeEvent('entity.mode.transition', { operatingMode: 'procedural' }),
    );
    expect(buildRecentTransitions(events)).toHaveLength(5);
  });

  it('falls back to summary when workflowSlug is absent', () => {
    const out = buildRecentTransitions([
      makeEvent('entity.procedure.activated', { summary: 'fallback label' }),
    ]);
    expect(out[0]!.label).toBe('fallback label');
  });

  it('truncates long labels to 200 chars', () => {
    const longLabel = 'x'.repeat(500);
    const out = buildRecentTransitions([
      makeEvent('entity.procedure.activated', { summary: longLabel }),
    ]);
    expect(out[0]!.label.length).toBe(200);
  });
});

// ============================================================================
// extractTriggerSource
// ============================================================================

describe('extractTriggerSource', () => {
  it('reads triggerSource from payload', () => {
    const ev = makeEvent('entity.interaction.started', {
      payload: { triggerSource: 'user' },
    });
    expect(extractTriggerSource(ev)).toBe('user');
  });

  it.each(['trigger', 'source', 'origin'])('also accepts %s as the field name', (field) => {
    const ev = makeEvent('entity.interaction.started', {
      payload: { [field]: 'schedule' },
    });
    expect(extractTriggerSource(ev)).toBe('schedule');
  });

  it('returns null on unknown values', () => {
    const ev = makeEvent('entity.interaction.started', {
      payload: { triggerSource: 'cosmic-ray' },
    });
    expect(extractTriggerSource(ev)).toBeNull();
  });

  it('returns null when no field matches', () => {
    const ev = makeEvent('entity.interaction.started', { payload: { foo: 'bar' } });
    expect(extractTriggerSource(ev)).toBeNull();
  });
});

// ============================================================================
// computeActiveSurfaceVersion
// ============================================================================

function makeRun(overrides: Partial<ActiveSurfaceRun> = {}): ActiveSurfaceRun {
  return {
    runId: '00000000-0000-4000-8000-000000000010',
    skillId: 'skill-1',
    skillName: 'Skill One',
    workflowSlug: 'demo',
    lifecycle: 'executing',
    startedAt: '2026-04-29T12:00:00.000Z',
    endedAt: null,
    graphFidelity: 'full',
    tasks: [
      {
        taskId: 't1',
        status: 'running',
        dependsOn: [],
        startedAt: '2026-04-29T12:00:01.000Z',
        completedAt: null,
      },
    ],
    ...overrides,
  };
}

const baseCoach: ActiveSurfaceSnapshot['coach'] = {
  lifecycle: 'idle',
  pendingProposals: 0,
  pendingPlatformIssues: 0,
  pendingAnomalies: 0,
};

describe('computeActiveSurfaceVersion', () => {
  it('returns the same hash for identical inputs', () => {
    const a = computeActiveSurfaceVersion({
      surfacedRuns: [makeRun()],
      coach: baseCoach,
      mode: 'procedural',
      triggerSource: 'user',
      helmsmanLifecycle: 'executing',
    });
    const b = computeActiveSurfaceVersion({
      surfacedRuns: [makeRun()],
      coach: baseCoach,
      mode: 'procedural',
      triggerSource: 'user',
      helmsmanLifecycle: 'executing',
    });
    expect(a).toBe(b);
  });

  it('changes when a task status changes', () => {
    const a = computeActiveSurfaceVersion({
      surfacedRuns: [makeRun()],
      coach: baseCoach,
      mode: 'procedural',
      triggerSource: 'user',
      helmsmanLifecycle: 'executing',
    });
    const b = computeActiveSurfaceVersion({
      surfacedRuns: [
        makeRun({
          tasks: [
            {
              taskId: 't1',
              status: 'succeeded',
              dependsOn: [],
              startedAt: '2026-04-29T12:00:01.000Z',
              completedAt: '2026-04-29T12:00:09.000Z',
            },
          ],
        }),
      ],
      coach: baseCoach,
      mode: 'procedural',
      triggerSource: 'user',
      helmsmanLifecycle: 'executing',
    });
    expect(a).not.toBe(b);
  });

  it('changes when coach state changes', () => {
    const a = computeActiveSurfaceVersion({
      surfacedRuns: [],
      coach: baseCoach,
      mode: null,
      triggerSource: null,
      helmsmanLifecycle: 'unknown',
    });
    const b = computeActiveSurfaceVersion({
      surfacedRuns: [],
      coach: {
        lifecycle: 'reviewing',
        pendingProposals: 1,
        pendingPlatformIssues: 0,
        pendingAnomalies: 0,
      },
      mode: null,
      triggerSource: null,
      helmsmanLifecycle: 'unknown',
    });
    expect(a).not.toBe(b);
  });

  it('is order-stable when active runs come back in different orders', () => {
    const r1 = makeRun({ runId: '00000000-0000-4000-8000-000000000001' });
    const r2 = makeRun({ runId: '00000000-0000-4000-8000-000000000002' });
    const a = computeActiveSurfaceVersion({
      surfacedRuns: [r1, r2],
      coach: baseCoach,
      mode: null,
      triggerSource: null,
      helmsmanLifecycle: 'unknown',
    });
    const b = computeActiveSurfaceVersion({
      surfacedRuns: [r2, r1],
      coach: baseCoach,
      mode: null,
      triggerSource: null,
      helmsmanLifecycle: 'unknown',
    });
    expect(a).toBe(b);
  });

  it('is order-stable across task ordering within a run', () => {
    const a = computeActiveSurfaceVersion({
      surfacedRuns: [
        makeRun({
          tasks: [
            { taskId: 't1', status: 'running', dependsOn: [], startedAt: null, completedAt: null },
            {
              taskId: 't2',
              status: 'scheduled',
              dependsOn: [],
              startedAt: null,
              completedAt: null,
            },
          ],
        }),
      ],
      coach: baseCoach,
      mode: null,
      triggerSource: null,
      helmsmanLifecycle: 'unknown',
    });
    const b = computeActiveSurfaceVersion({
      surfacedRuns: [
        makeRun({
          tasks: [
            {
              taskId: 't2',
              status: 'scheduled',
              dependsOn: [],
              startedAt: null,
              completedAt: null,
            },
            { taskId: 't1', status: 'running', dependsOn: [], startedAt: null, completedAt: null },
          ],
        }),
      ],
      coach: baseCoach,
      mode: null,
      triggerSource: null,
      helmsmanLifecycle: 'unknown',
    });
    expect(a).toBe(b);
  });

  it('produces a 16-char hex digest', () => {
    const v = computeActiveSurfaceVersion({
      surfacedRuns: [],
      coach: baseCoach,
      mode: null,
      triggerSource: null,
      helmsmanLifecycle: 'unknown',
    });
    expect(v).toMatch(/^[0-9a-f]{16}$/);
  });
});
