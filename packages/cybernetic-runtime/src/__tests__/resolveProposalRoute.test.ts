import { describe, expect, it } from 'vitest';
import {
  resolveProposalRoute,
  proposalDirForRoute,
  proposalPath,
  PROPOSAL_DIRS,
  PROPOSAL_TENANT_DIR,
  PROPOSAL_PLATFORM_DIR,
} from '../stagedChange/resolveProposalRoute.js';
import type { StagedChangeOp } from '@aflow/schemas';

describe('resolveProposalRoute', () => {
  it('routes tenant skill targets to tenant_ratification', () => {
    const ops: StagedChangeOp[] = [{ op: 'update_task_goal', taskId: 't1', newGoal: 'do x' }];
    expect(resolveProposalRoute({ targetSlug: 'kaggle-titanic', ops })).toBe('tenant_ratification');
  });

  it('routes platform-owned workflows to platform_issue', () => {
    const ops: StagedChangeOp[] = [
      { op: 'update_task_goal', taskId: 'draft-evals', newGoal: 'fix shape' },
    ];
    expect(resolveProposalRoute({ targetSlug: 'compose-skill', ops })).toBe('platform_issue');
    expect(resolveProposalRoute({ targetSlug: 'bind-capability', ops })).toBe('platform_issue');
  });

  it('routes platform_issue ops to platform_issue regardless of target', () => {
    const ops: StagedChangeOp[] = [
      {
        op: 'platform_issue',
        subjectKind: 'runtime',
        summary: 'Executor missing',
      },
    ];
    expect(resolveProposalRoute({ targetSlug: 'kaggle-titanic', ops })).toBe('platform_issue');
    // Even with no target, an explicit platform_issue op routes to platform_issue
    expect(resolveProposalRoute({ ops })).toBe('platform_issue');
  });

  it('defaults to tenant_ratification when targetSlug is omitted and ops are tenant-side', () => {
    const ops: StagedChangeOp[] = [
      { op: 'flag_pattern', patternDescription: 'recurring user request' },
    ];
    expect(resolveProposalRoute({ ops })).toBe('tenant_ratification');
  });

  it('proposalDirForRoute and proposalPath return the right surfaces', () => {
    expect(proposalDirForRoute('tenant_ratification')).toBe(PROPOSAL_TENANT_DIR);
    expect(proposalDirForRoute('platform_issue')).toBe(PROPOSAL_PLATFORM_DIR);
    expect(proposalPath('tenant_ratification', 'abc')).toBe('/coach/staged/abc.json');
    expect(proposalPath('platform_issue', 'xyz')).toBe('/coach/platform-issues/xyz.json');
  });

  it('PROPOSAL_DIRS exposes both surfaces in scan order', () => {
    expect(new Set(PROPOSAL_DIRS)).toEqual(new Set(['/coach/staged', '/coach/platform-issues']));
  });
});
