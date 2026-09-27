import type { CandidateLearning } from '@aflow/schemas';
import { isFastInjectLearningKind } from '@aflow/schemas';

export interface TrajectorySummary {
  direction: 'maximize' | 'minimize';
  metricKey?: string;
  series: number[];
}

export interface CandidateLedgerPromptOptions {
  trajectory?: TrajectorySummary;
  /** The ledger's campaign has ended: a promotion to its campaign scope would
   *  never be injected again, so the resolve instruction steers promotions to
   *  skill scope only. */
  campaignEnded?: boolean;
}

/**
 * Build the Coach-brief candidate-ledger block. Returns `''` when there is
 * nothing to surface (no pending + no rejected). The block teaches the resolve
 * action: promote via `learner.learning.record` + `promotedFrom`, or reject via
 * `learner.learning.resolve_candidate`.
 */
export function formatCandidateLedgerForPrompt(
  candidates: readonly CandidateLearning[],
  options: CandidateLedgerPromptOptions = {},
): string {
  const { trajectory, campaignEnded } = options;
  const pending = candidates.filter((c) => c.status === 'pending');
  const negative = candidates.filter(
    (c) => c.status === 'reviewed-rejected' || c.status === 'reviewed-noise',
  );
  if (pending.length === 0 && negative.length === 0) return '';

  const allCampaign = candidates.every((c) => c.campaignId !== undefined);
  const lines: string[] = [
    allCampaign
      ? 'Campaign candidate learnings (vet before they compound):'
      : "Candidate learnings from this skill's runs (vet before they compound):",
  ];

  if (trajectory) {
    const peak =
      trajectory.series.length > 0
        ? trajectory.direction === 'minimize'
          ? Math.min(...trajectory.series)
          : Math.max(...trajectory.series)
        : undefined;
    lines.push(
      `  Trajectory: ${trajectory.direction} ${trajectory.metricKey ?? 'score'}; ` +
        `peak=${peak ?? '(none)'}; recent=[${trajectory.series.slice(-5).join(', ')}]`,
    );
  }

  // Bounded growth of these sections on a long campaign is owned by 183e Phase
  // 1b (consolidation/decay) — no arbitrary cap here ([[feedback_no-magic-constants]]).
  if (pending.length > 0) {
    lines.push('  PENDING (decide: promote, reject, or noise):');
    for (const c of pending) {
      const gate = isFastInjectLearningKind(c.learning.kind) ? 'fast-inject' : 'block-until-vetted';
      lines.push(
        `    - [entry ${c.entryId} | run ${c.runId} · ${c.learning.id}] kind=${c.learning.kind} (${gate}): ${c.learning.observation}` +
          (c.learning.recommendation ? ` → ${c.learning.recommendation}` : ''),
      );
    }
  }

  if (negative.length > 0) {
    lines.push('  ALREADY REJECTED (negative evidence — do NOT re-propose):');
    for (const c of negative) {
      lines.push(`    - [${c.status}] ${c.learning.observation}`);
    }
  }

  lines.push(
    campaignEnded
      ? 'Resolve each PENDING entry: this campaign is over, so a promotion to its campaign ' +
          'scope would never be injected again — promote only claims that generalize, by ' +
          'recording a CoachLearning at skill scope (stages for operator review) with ' +
          '`promotedFrom={candidateLedgerEntryId}`; reject or mark as noise the rest with one ' +
          'batched `learner.learning.resolve_candidate` call, addressing entries by their ' +
          '(runId, learningId).'
      : 'Resolve each PENDING entry you have evidence on: promote a good learning by recording a ' +
          'CoachLearning with `promotedFrom={candidateLedgerEntryId}` — campaign scope (include ' +
          '`campaignId`) for campaign entries, skill scope (stages for operator review) for process ' +
          'entries; reject bad/noisy ones with one batched `learner.learning.resolve_candidate` ' +
          'call, addressing entries by their (runId, learningId). A rejected entry stops being ' +
          'injected into the next attempt. If the trajectory regressed from its peak, the most ' +
          'recent fast-learning is the prime suspect.',
  );

  return lines.join('\n');
}
