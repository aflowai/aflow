import { describe, it, expect } from 'vitest';
import {
  ArtifactInspectListInputSchema,
  ArtifactInspectListOutputSchema,
  ArtifactInspectReadInputSchema,
  isStableInspectPath,
  StagedChangeSchema,
} from '../index.js';

describe('ArtifactInspectListInputSchema', () => {
  it('accepts targetKind=run', () => {
    const r = ArtifactInspectListInputSchema.safeParse({
      targetKind: 'run',
      targetId: '00000000-0000-0000-0000-000000000001',
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown targetKind', () => {
    const r = ArtifactInspectListInputSchema.safeParse({
      targetKind: 'workflow',
      targetId: '00000000-0000-0000-0000-000000000001',
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty targetId', () => {
    const r = ArtifactInspectListInputSchema.safeParse({
      targetKind: 'run',
      targetId: '',
    });
    expect(r.success).toBe(false);
  });
});

describe('ArtifactInspectReadInputSchema', () => {
  it('accepts a well-formed read with optional maxBytes', () => {
    const r = ArtifactInspectReadInputSchema.safeParse({
      targetKind: 'run',
      targetId: '00000000-0000-0000-0000-000000000001',
      path: 'run/tasks/train-model/reflection',
      maxBytes: 4096,
    });
    expect(r.success).toBe(true);
  });

  it('clamps invalid maxBytes (< 256) at the schema layer', () => {
    const r = ArtifactInspectReadInputSchema.safeParse({
      targetKind: 'run',
      targetId: '00000000-0000-0000-0000-000000000001',
      path: 'run/header',
      maxBytes: 100,
    });
    expect(r.success).toBe(false);
  });
});

describe('ArtifactInspectListOutputSchema', () => {
  it('accepts an empty index', () => {
    const r = ArtifactInspectListOutputSchema.safeParse({
      targetKind: 'run',
      targetId: '00000000-0000-0000-0000-000000000001',
      entries: [],
    });
    expect(r.success).toBe(true);
  });

  it('accepts index entries with optional sizeBytes', () => {
    const r = ArtifactInspectListOutputSchema.safeParse({
      targetKind: 'run',
      targetId: '00000000-0000-0000-0000-000000000001',
      entries: [
        { path: 'run/header', kind: 'summary', summary: 'header' },
        {
          path: 'run/tasks/x/output',
          kind: 'payload',
          summary: 'output payload',
          sizeBytes: 1024,
        },
      ],
    });
    expect(r.success).toBe(true);
  });
});

describe('isStableInspectPath', () => {
  const cases: Array<{ kind: 'run' | 'task' | 'session'; path: string; ok: boolean }> = [
    // run
    { kind: 'run', path: 'run/header', ok: true },
    { kind: 'run', path: 'run/tasks', ok: true },
    { kind: 'run', path: 'run/eval', ok: true },
    { kind: 'run', path: 'run/tasks/train-model/meta', ok: true },
    { kind: 'run', path: 'run/tasks/train-model/reflection', ok: true },
    { kind: 'run', path: 'run/tasks/train-model/input', ok: true },
    { kind: 'run', path: 'run/tasks/train-model/output', ok: true },
    { kind: 'run', path: 'run/tasks/train-model', ok: false }, // missing slice
    { kind: 'run', path: 'run/tasks/train-model/everything', ok: false }, // unknown slice
    { kind: 'run', path: 'run/extra', ok: false },
    { kind: 'run', path: '../etc/passwd', ok: false },
    // task
    { kind: 'task', path: 'task/meta', ok: true },
    { kind: 'task', path: 'task/reflection', ok: true },
    { kind: 'task', path: 'task/input', ok: true },
    { kind: 'task', path: 'task/output', ok: true },
    { kind: 'task', path: 'task/everything', ok: false },
    { kind: 'task', path: 'run/header', ok: false }, // wrong kind prefix
    // session
    { kind: 'session', path: 'session/meta', ok: true },
    { kind: 'session', path: 'session/steps', ok: true },
    { kind: 'session', path: 'session/steps/abc-123', ok: true },
    { kind: 'session', path: 'session/extra', ok: false },
    { kind: 'session', path: 'session/steps/abc/extra', ok: false },
  ];

  for (const c of cases) {
    it(`${c.kind} :: ${c.path} → ${String(c.ok)}`, () => {
      expect(isStableInspectPath(c.kind, c.path)).toBe(c.ok);
    });
  }
});

describe('StagedChange.evidence.artifactRefs', () => {
  const RUN_ID = '00000000-0000-0000-0000-000000000001';
  function baseProposal(): Record<string, unknown> {
    return {
      id: '11111111-1111-1111-1111-111111111111',
      kind: 'workflow_refinement',
      source: 'coach',
      status: 'proposed',
      targetWorkflowSlug: 'my-skill',
      proposal: {
        summary: 's',
        rationale: 'r',
        confidence: 'medium',
        ops: [{ op: 'update_task_goal', taskId: 't', newGoal: 'g' }],
      },
      evidence: {
        sourceSessionIds: [RUN_ID],
        digestRef: '/coach/digests/' + RUN_ID + '.json',
        digestSha256: 'a'.repeat(64),
        digestCitations: [{ runId: RUN_ID }],
        diagnosis: { issueCategory: 'procedure' },
        warrant: {
          claim: 'c',
          evidenceSummary: 'e',
          warrant: 'w',
          causeStatus: 'observed',
          expectedEffect: 'x',
        },
        applyPreview: {
          attempted: true,
          result: 'ok',
          previewedAt: '2026-05-26T00:00:00.000Z',
          workflowRevisionAtPreview: 4,
        },
      },
      authorityLevel: 'stage_for_review',
      resolutionRoute: 'tenant_ratification',
      proposedAt: '2026-05-26T00:00:00.000Z',
      expiresAt: '2026-05-26T00:00:00.000Z',
      coachSessionId: '33333333-3333-3333-3333-333333333333',
    };
  }

  it('accepts a proposal with artifactRefs[]', () => {
    const sc = baseProposal();
    (sc.evidence as Record<string, unknown>)['artifactRefs'] = [
      {
        targetKind: 'run',
        targetId: RUN_ID,
        path: 'run/tasks/train/reflection',
        note: 'reflection cited missingInputs=column_x',
      },
    ];
    const r = StagedChangeSchema.safeParse(sc);
    expect(r.success).toBe(true);
  });

  it('accepts a proposal without artifactRefs[] (optional)', () => {
    const r = StagedChangeSchema.safeParse(baseProposal());
    expect(r.success).toBe(true);
  });

  it('rejects artifactRefs with an unknown targetKind', () => {
    const sc = baseProposal();
    (sc.evidence as Record<string, unknown>)['artifactRefs'] = [
      { targetKind: 'workflow', targetId: RUN_ID, path: 'run/header' },
    ];
    const r = StagedChangeSchema.safeParse(sc);
    expect(r.success).toBe(false);
  });

  it('caps artifactRefs at 20 entries', () => {
    const sc = baseProposal();
    (sc.evidence as Record<string, unknown>)['artifactRefs'] = Array.from({ length: 21 }, () => ({
      targetKind: 'run',
      targetId: RUN_ID,
      path: 'run/header',
    }));
    const r = StagedChangeSchema.safeParse(sc);
    expect(r.success).toBe(false);
  });
});
