import { describe, it, expect } from 'vitest';
import {
  failedApplyVariant,
  shouldShowActiveReview,
  formatSystemStatusLine,
  type CoachProposalSummary,
} from './use-coach-surface.js';

// ============================================================================
// Fixtures
// ============================================================================

function makeProposal(overrides: Partial<CoachProposalSummary> = {}): CoachProposalSummary {
  return {
    id: '00000000-0000-0000-0000-00000000a001',
    kind: 'workflow_refinement',
    status: 'proposed',
    summary: 'Tighten goal on task-a',
    rationale: '',
    confidence: 'medium',
    targetWorkflowSlug: 'my-skill',
    opCount: 1,
    opKinds: ['update_task_goal'],
    authorityLevel: 'stage_for_review',
    resolutionRoute: 'tenant_ratification',
    proposedAt: '2026-05-13T00:00:00.000Z',
    expiresAt: '2026-06-13T00:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    hasReflectionEvidence: false,
    ...overrides,
  };
}

// ============================================================================

describe('useCoachSurface — proposals fetch stays trimmed (Plan 156 §7A.3 Phase C)', () => {
  it('does not fetch /spaces/:id/proposals — that lives on useActionCenter now', () => {
    // Module-internal `readFileSync` rather than importing the hook
    // (importing would resolve all of its React + TanStack deps and
    // pull JSDOM-class concerns into this node-env test).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'use-coach-surface.ts'), 'utf8');

    // The pre-7A.3 list fetch URL. Must NOT appear as actual code
    // (the doc-comment that mentions the removal lives in a `//`
    // line so it won't match this anchored pattern).
    expect(src).not.toMatch(/\/proposals\?pendingOnly=/);
    // The `proposalsQueryKey` helper was removed too — only check
    // the call-site syntax (a comment naming the symbol shouldn't
    // fire).
    expect(src).not.toMatch(/function proposalsQueryKey\(|proposalsQueryKey\(spaceId/);

    // The three standalone-verb endpoints that USED to live on the
    // hook (`postAction` callers — ratify / reject / dismiss). They
    // now flow through `useActionCenter.resolve(itemId, ...)`. The
    // remaining Coach-only proposal endpoints (`force=true`,
    // `regenerate`, the GET detail-loader) stay — match their
    // distinguishing path suffixes to be sure we're catching the
    // right thing.
    expect(src).not.toMatch(/\/proposals\/\$\{proposalId\}\/ratify`/); // plain ratify (no ?force=true)
    expect(src).not.toMatch(/\/proposals\/\$\{proposalId\}\/reject/);
    expect(src).not.toMatch(/\/proposals\/\$\{proposalId\}\/dismiss/);

    // Sanity: the Coach-only endpoints that survive the trim are
    // still wired. If any of these vanish we've gone too far — they
    // have no AC analog and the panel relies on them.
    expect(src).toMatch(/\/proposals\/\$\{proposalId\}\/ratify\?force=true/);
    expect(src).toMatch(/\/proposals\/\$\{proposalId\}\/regenerate/);
    // GET-by-id (loadProposalDetail) — anchored via the surrounding
    // authFetch call shape so a stray template literal mention
    // elsewhere doesn't match.
    expect(src).toMatch(
      /authFetch\(`\$\{apiUrl\}\/spaces\/\$\{spaceId\}\/proposals\/\$\{proposalId\}`/,
    );
  });
});

// ============================================================================
// failedApplyVariant
// ============================================================================

describe('failedApplyVariant', () => {
  it('returns null when there is no recorded error', () => {
    expect(failedApplyVariant(undefined)).toBeNull();
  });

  it('classifies workflow_not_found as stale_target (Retry would not help)', () => {
    const variant = failedApplyVariant({
      reason: 'workflow_not_found',
      op: 'unknown',
      detail: 'Workflow not found at /workflows/X',
      at: '2026-05-13T00:00:00.000Z',
    });
    expect(variant).toBe('stale_target');
  });

  it('classifies target_skill_missing as stale_target', () => {
    const variant = failedApplyVariant({
      reason: 'target_skill_missing',
      op: 'update_task_goal',
      detail: 'Task task-a not found',
      at: '2026-05-13T00:00:00.000Z',
    });
    expect(variant).toBe('stale_target');
  });

  it('classifies platform_artifact_read_only as stale_target', () => {
    const variant = failedApplyVariant({
      reason: 'platform_artifact_read_only',
      op: 'platform_artifact_read_only',
      detail: 'Cannot mutate platform workflow',
      at: '2026-05-13T00:00:00.000Z',
    });
    expect(variant).toBe('stale_target');
  });

  it('classifies transient as transient (Retry is the right action)', () => {
    const variant = failedApplyVariant({
      reason: 'transient',
      op: 'add_task',
      detail: 'random failure',
      at: '2026-05-13T00:00:00.000Z',
    });
    expect(variant).toBe('transient');
  });

  it('classifies post_validation as transient', () => {
    // Post-validation failures are Coach bugs — Retry won't help in the
    // strict sense, but the operator might want to retry after manually
    // editing the upstream artifact. We treat as transient so the user
    // gets the choice rather than a hard-disabled Ratify.
    const variant = failedApplyVariant({
      reason: 'post_validation',
      op: 'post_validation',
      detail: 'Graph validation failed',
      at: '2026-05-13T00:00:00.000Z',
    });
    expect(variant).toBe('transient');
  });

  it('classifies unknown as transient (safe default)', () => {
    const variant = failedApplyVariant({
      reason: 'unknown',
      op: '?',
      detail: '?',
      at: '2026-05-13T00:00:00.000Z',
    });
    expect(variant).toBe('transient');
  });
});

// ============================================================================
// shouldShowActiveReview
// ============================================================================

describe('shouldShowActiveReview', () => {
  it('returns false when Coach is idle', () => {
    expect(shouldShowActiveReview('idle')).toBe(false);
  });

  it('returns true when Coach is reviewing', () => {
    expect(shouldShowActiveReview('reviewing')).toBe(true);
  });

  it('returns true when Coach is stalled (operator should investigate)', () => {
    expect(shouldShowActiveReview('stalled')).toBe(true);
  });
});

// ============================================================================
// formatSystemStatusLine
// ============================================================================

describe('formatSystemStatusLine', () => {
  it('formats both lines when a recent run is present', () => {
    const lines = formatSystemStatusLine({
      helmsmanLifecycle: 'awaiting_user',
      recentRun: {
        runId: 'r1',
        workflowSlug: 'weekly-roundup',
        skillName: 'Weekly Roundup',
        lifecycle: 'completed',
        endedAt: '2026-05-13T00:00:00.000Z',
      },
    });
    expect(lines.helmsman).toBe('Helmsman · awaiting_user');
    expect(lines.run).toBe('last skill · Weekly Roundup · completed');
  });

  it('falls back to workflowSlug when skillName is unset', () => {
    const lines = formatSystemStatusLine({
      helmsmanLifecycle: 'executing',
      recentRun: {
        runId: 'r1',
        workflowSlug: 'my-skill',
        skillName: null,
        lifecycle: 'executing',
        endedAt: null,
      },
    });
    expect(lines.run).toBe('last skill · my-skill · executing');
  });

  it('formats "no recent run" when there is no surfaced run', () => {
    const lines = formatSystemStatusLine({
      helmsmanLifecycle: 'awaiting_user',
      recentRun: null,
    });
    expect(lines.run).toBe('no recent run');
  });

  it('shows "Helmsman · idle" when lifecycle is null', () => {
    const lines = formatSystemStatusLine({
      helmsmanLifecycle: null,
      recentRun: null,
    });
    expect(lines.helmsman).toBe('Helmsman · idle');
  });
});
