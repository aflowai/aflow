import { describe, expect, it } from 'vitest';
import {
  inferSourceFromKind,
  resolveStagedChangeSource,
  StagedChangeSchema,
  validateCoachAuthoredProposal,
  type StagedChange,
} from '../cybernetic/stagedChange.js';

const VALID_SHA256 = 'a'.repeat(64);
const RUN_ID = '00000000-0000-0000-0000-000000000001';

function baseProposal(overrides: Partial<StagedChange> = {}): StagedChange {
  const now = new Date().toISOString();
  return {
    id: '11111111-1111-1111-1111-111111111111',
    kind: 'workflow_refinement',
    source: 'coach',
    status: 'proposed',
    targetWorkflowSlug: 'kaggle-housing',
    proposal: {
      summary: 'Tighten train task',
      rationale: 'Train task timed out twice; reduce estimator count.',
      confidence: 'medium',
      ops: [
        {
          op: 'update_task_goal',
          taskId: 'train',
          newGoal: 'Train RandomForest with bounded depth.',
        },
      ],
    },
    evidence: {
      sourceSessionIds: [RUN_ID],
      digestRef: '/coach/digests/22222222-2222-2222-2222-222222222222.json',
      digestSha256: VALID_SHA256,
      digestCitations: [{ runId: RUN_ID, taskId: 'train' }],
      diagnosis: { issueCategory: 'procedure' },
      warrant: {
        claim: 'Train task needs bounded depth',
        evidenceSummary: 'Two consecutive timeouts at default depth.',
        warrant: 'Bounded depth caps cost and avoids the timeout.',
        causeStatus: 'observed',
        expectedEffect: 'Next train run completes inside the budget.',
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
    proposedAt: now,
    expiresAt: now,
    coachSessionId: '33333333-3333-3333-3333-333333333333',
    ...overrides,
  };
}

describe('StagedChange resolutionRoute field (Plan 115)', () => {
  it('accepts a valid route value', () => {
    const result = StagedChangeSchema.safeParse(
      baseProposal({ resolutionRoute: 'tenant_ratification' }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts platform_issue route', () => {
    const result = StagedChangeSchema.safeParse(
      baseProposal({ resolutionRoute: 'platform_issue', targetWorkflowSlug: 'compose-skill' }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a missing resolutionRoute', () => {
    const sc = baseProposal();
    delete (sc as { resolutionRoute?: unknown }).resolutionRoute;
    const result = StagedChangeSchema.safeParse(sc);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown route value', () => {
    const sc = baseProposal();
    (sc as unknown as { resolutionRoute: string }).resolutionRoute = 'something_else';
    const result = StagedChangeSchema.safeParse(sc);
    expect(result.success).toBe(false);
  });
});

describe('StagedChange source field', () => {
  it('accepts source on a proposal', () => {
    const result = StagedChangeSchema.safeParse(baseProposal());
    expect(result.success).toBe(true);
  });

  it('parses without source for legacy proposals', () => {
    const legacy = baseProposal();
    delete (legacy as { source?: unknown }).source;
    const result = StagedChangeSchema.safeParse(legacy);
    expect(result.success).toBe(true);
  });

  it('infers source from kind for legacy proposals', () => {
    expect(inferSourceFromKind('workflow_refinement')).toBe('coach');
    expect(inferSourceFromKind('eval_criterion_change')).toBe('coach');
    expect(inferSourceFromKind('pattern_flag')).toBe('coach');
    expect(inferSourceFromKind('platform_issue')).toBe('coach');
    expect(inferSourceFromKind('workflow_block')).toBe('coach');
    expect(inferSourceFromKind('skill_compose')).toBe('compose_skill');
    expect(inferSourceFromKind('capability_binding')).toBe('bind_capability');
    expect(inferSourceFromKind('directive_amendment')).toBe('operator');
  });

  it('resolveStagedChangeSource uses explicit source when present, else falls back to kind', () => {
    const explicit = baseProposal({ source: 'coach', kind: 'directive_amendment' });
    expect(resolveStagedChangeSource(explicit)).toBe('coach');

    const legacy = baseProposal({ kind: 'directive_amendment' });
    delete (legacy as { source?: unknown }).source;
    expect(resolveStagedChangeSource(legacy)).toBe('operator');
  });
});

describe('validateCoachAuthoredProposal', () => {
  it('passes a well-formed Coach proposal', () => {
    const issues = validateCoachAuthoredProposal(baseProposal());
    expect(issues).toEqual([]);
  });

  it('does not validate non-Coach sources', () => {
    const compose = baseProposal({
      source: 'compose_skill',
      kind: 'skill_compose',
      evidence: { sourceSessionIds: [RUN_ID] }, // no diagnosis fields
    });
    expect(validateCoachAuthoredProposal(compose)).toEqual([]);
  });

  it('rejects missing diagnosis.issueCategory on Coach proposals', () => {
    const broken = baseProposal();
    broken.evidence = {
      ...broken.evidence,
      ...(broken.evidence.diagnosis ? {} : {}),
    };
    delete (broken.evidence as { diagnosis?: unknown }).diagnosis;
    const issues = validateCoachAuthoredProposal(broken);
    expect(issues.find((i) => i.field === 'evidence.diagnosis.issueCategory')).toBeDefined();
  });

  it('requires digestCitations (but not digestRef/digestSha256 — no persisted digest)', () => {
    const broken = baseProposal();
    delete (broken.evidence as { digestRef?: unknown }).digestRef;
    delete (broken.evidence as { digestSha256?: unknown }).digestSha256;
    delete (broken.evidence as { digestCitations?: unknown }).digestCitations;
    const issues = validateCoachAuthoredProposal(broken);
    expect(issues.find((i) => i.field === 'evidence.digestCitations')).toBeDefined();
    expect(issues.find((i) => i.field === 'evidence.digestRef')).toBeUndefined();
    expect(issues.find((i) => i.field === 'evidence.digestSha256')).toBeUndefined();
  });

  it('requires runId on every digest citation', () => {
    const broken = baseProposal();
    broken.evidence.digestCitations = [{ runId: '' }];
    const issues = validateCoachAuthoredProposal(broken);
    expect(issues.find((i) => i.field === 'evidence.digestCitations[].runId')).toBeDefined();
  });

  it('waives the digest trio for workflow_refinement carrying validityDiagnostics (Plan 183g §2.2)', () => {
    const repair = baseProposal();
    delete (repair.evidence as { digestRef?: unknown }).digestRef;
    delete (repair.evidence as { digestSha256?: unknown }).digestSha256;
    delete (repair.evidence as { digestCitations?: unknown }).digestCitations;
    repair.evidence.validityDiagnostics = [
      {
        code: 'missing_dependency',
        dimension: 'graph',
        severity: 'error',
        taskId: 'train',
        detail: 'Task train depends on a task that does not exist.',
      },
    ];
    expect(validateCoachAuthoredProposal(repair)).toEqual([]);
  });

  it('does NOT waive the citation requirement for non-refinement kinds even with validityDiagnostics attached', () => {
    const smuggled = baseProposal({ kind: 'eval_criterion_change' });
    delete (smuggled.evidence as { digestCitations?: unknown }).digestCitations;
    smuggled.evidence.validityDiagnostics = [
      {
        code: 'missing_dependency',
        dimension: 'graph',
        severity: 'error',
        taskId: 'train',
        detail: 'Task train depends on a task that does not exist.',
      },
    ];
    const issues = validateCoachAuthoredProposal(smuggled);
    expect(issues.find((i) => i.field === 'evidence.digestCitations')).toBeDefined();
  });

  it("rejects a Coach-authored 'flag_pattern' op (advisory, not a skill edit)", () => {
    const broken = baseProposal();
    broken.proposal.ops = [{ op: 'flag_pattern', patternDescription: 'recurring 403' }];
    const issues = validateCoachAuthoredProposal(broken);
    const opIssue = issues.find((i) => i.field === 'proposal.ops');
    expect(opIssue).toBeDefined();
    expect(opIssue?.message).toContain('flag_pattern');
  });

  it('rejects capability.definition.upsert on Coach-authored proposals', () => {
    const broken = baseProposal({
      proposal: {
        summary: 'Bind new capability',
        rationale: 'Coach should not author this.',
        confidence: 'medium',
        ops: [
          {
            op: 'capability.definition.upsert',
            kind: 'api',
            apiId: 'whatever',
            definition: {
              name: 'WhateverAPI',
              baseUrl: 'https://api.example.com',
              authKind: 'none',
              endpoints: [],
            },
            rationale: 'Coach overstep',
          },
        ],
      },
    });
    const issues = validateCoachAuthoredProposal(broken);
    expect(issues.find((i) => i.field === 'proposal.ops')).toBeDefined();
    const opIssue = issues.find((i) => i.field === 'proposal.ops');
    expect(opIssue?.message).toContain('capability.definition.upsert');
    expect(opIssue?.message).toContain('bind-capability');
  });

  it('rejects capability.binding.remove on Coach-authored proposals', () => {
    const broken = baseProposal({
      proposal: {
        summary: 'Remove binding',
        rationale: 'Coach should not author this either.',
        confidence: 'medium',
        ops: [
          {
            op: 'capability.binding.remove',
            bindingId: 'some-binding',
            rationale: 'Coach overstep',
          },
        ],
      },
    });
    const issues = validateCoachAuthoredProposal(broken);
    expect(issues.find((i) => i.field === 'proposal.ops')).toBeDefined();
  });

  it('enforces eval_suite category requires eval.criterion.* ops only', () => {
    const broken = baseProposal({
      proposal: {
        summary: 'Mixed ops',
        rationale: 'Mixing categories.',
        confidence: 'medium',
        ops: [
          {
            op: 'update_task_goal',
            taskId: 'train',
            newGoal: 'Updated goal',
          },
        ],
      },
      evidence: {
        ...baseProposal().evidence,
        diagnosis: { issueCategory: 'eval_suite' },
      },
    });
    const issues = validateCoachAuthoredProposal(broken);
    expect(issues.find((i) => i.field === 'evidence.diagnosis.issueCategory')).toBeDefined();
  });

  it('accepts eval_suite category when ops are exclusively eval.criterion.*', () => {
    const ok = baseProposal({
      proposal: {
        summary: 'Add eval criterion',
        rationale: 'Tighten the eval suite.',
        confidence: 'medium',
        ops: [
          {
            op: 'eval.criterion.add',
            skillSlug: 'kaggle-housing',
            criterion: { type: 'threshold' },
            targetScope: 'goal',
            rationale: 'Need a threshold for accuracy.',
          },
        ],
      },
      evidence: {
        ...baseProposal().evidence,
        diagnosis: { issueCategory: 'eval_suite' },
      },
    });
    expect(validateCoachAuthoredProposal(ok)).toEqual([]);
  });

  // ========================================================================

  it('rejects a Coach proposal missing evidence.warrant (Plan 163 §6.4)', () => {
    const broken = baseProposal();
    delete (broken.evidence as { warrant?: unknown }).warrant;
    const issues = validateCoachAuthoredProposal(broken);
    expect(issues.find((i) => i.field === 'evidence.warrant')).toBeDefined();
  });

  it('rejects a Coach proposal missing evidence.applyPreview (Plan 163 §6.5)', () => {
    const broken = baseProposal();
    delete (broken.evidence as { applyPreview?: unknown }).applyPreview;
    const issues = validateCoachAuthoredProposal(broken);
    expect(issues.find((i) => i.field === 'evidence.applyPreview')).toBeDefined();
  });

  it('legacy proposals (sourceless, kind=workflow_refinement) still validate as Coach — and now also require warrant + applyPreview', () => {
    const legacy = baseProposal();
    delete (legacy as { source?: unknown }).source;
    delete (legacy.evidence as { warrant?: unknown }).warrant;
    delete (legacy.evidence as { applyPreview?: unknown }).applyPreview;
    const issues = validateCoachAuthoredProposal(legacy);
    expect(issues.find((i) => i.field === 'evidence.warrant')).toBeDefined();
    expect(issues.find((i) => i.field === 'evidence.applyPreview')).toBeDefined();
  });

  it('accepts platform_issue Coach proposals without evidence.warrant or evidence.applyPreview', () => {
    const platformIssue = baseProposal({
      kind: 'platform_issue',
      resolutionRoute: 'platform_issue',
      proposal: {
        summary: 'Platform issue: provider 5xx',
        rationale: 'Tasks failing on provider outage.',
        confidence: 'medium',
        ops: [
          {
            op: 'platform_issue',
            summary: 'provider 5xx',
            severity: 'medium',
          },
        ],
      },
    });
    delete (platformIssue.evidence as { warrant?: unknown }).warrant;
    delete (platformIssue.evidence as { applyPreview?: unknown }).applyPreview;
    const issues = validateCoachAuthoredProposal(platformIssue);
    expect(issues.find((i) => i.field === 'evidence.warrant')).toBeUndefined();
    expect(issues.find((i) => i.field === 'evidence.applyPreview')).toBeUndefined();
  });

  it('accepts pattern_flag Coach proposals without evidence.warrant or evidence.applyPreview', () => {
    const patternFlag = baseProposal({
      kind: 'pattern_flag',
      proposal: {
        summary: 'Pattern: train task slow',
        rationale: 'Recurring slowness on train task.',
        confidence: 'low',
        ops: [
          {
            op: 'flag_pattern',
            patternDescription: 'train task slow',
          },
        ],
      },
    });
    delete (patternFlag.evidence as { warrant?: unknown }).warrant;
    delete (patternFlag.evidence as { applyPreview?: unknown }).applyPreview;
    const issues = validateCoachAuthoredProposal(patternFlag);
    expect(issues.find((i) => i.field === 'evidence.warrant')).toBeUndefined();
    expect(issues.find((i) => i.field === 'evidence.applyPreview')).toBeUndefined();
  });

  it('accepts workflow_block Coach proposals without evidence.warrant or evidence.applyPreview', () => {
    const block = baseProposal({
      kind: 'workflow_block',
      proposal: {
        summary: 'Block workflow',
        rationale: 'Critical regression.',
        confidence: 'high',
        ops: [
          {
            op: 'block_workflow',
            reason: 'Critical regression observed.',
          },
        ],
      },
    });
    delete (block.evidence as { warrant?: unknown }).warrant;
    delete (block.evidence as { applyPreview?: unknown }).applyPreview;
    const issues = validateCoachAuthoredProposal(block);
    expect(issues.find((i) => i.field === 'evidence.warrant')).toBeUndefined();
    expect(issues.find((i) => i.field === 'evidence.applyPreview')).toBeUndefined();
  });
});
