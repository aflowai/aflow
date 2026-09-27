import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { CoachLearning } from '@aflow/schemas';
import { listDurableCoachLearnings, type CampaignScopeFilter } from '../coachLearningsStore.js';

export interface LoadCoachLearningsParams {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  /** The skill whose learnings we want; nothing returned if undefined. */
  workflowSlug: string;
  /** Max records returned; bounded for the synchronous trigger pipeline. */
  limit?: number;
  /** Defaults to the full brief read (`skill-campaigns`). */
  campaignScope?: CampaignScopeFilter;
  /** Passed through to `DurableCoachLearningsFilter.includeProposed`. */
  includeProposed?: boolean;
}

export async function loadRecentLearnings(
  params: LoadCoachLearningsParams,
): Promise<CoachLearning[]> {
  const { db, tenantId, spaceId, workflowSlug } = params;
  const limit = params.limit ?? 100;
  try {
    return await listDurableCoachLearnings(db, tenantId, {
      spaceId,
      skillSlug: workflowSlug,
      campaignScope: params.campaignScope ?? { mode: 'skill-campaigns' },
      ...(params.includeProposed ? { includeProposed: true } : {}),
      limit,
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Prompt formatter
// ---------------------------------------------------------------------------

export interface LearningSetStateForPrompt {
  activeSetSize: number;
  budget: number;
  consolidationDue: boolean;
}

/** One durable learning as a prompt line — the id leads so `supersedes` and
 *  `learner.learning.consolidate` can take it verbatim. A `proposed` row
 *  (visible only to includeProposed reads) is marked so the Coach knows it
 *  exists but is not yet operator-approved. */
export function formatLearningLine(l: CoachLearning): string {
  const scopeLabel =
    l.scope.kind === 'space'
      ? 'space'
      : l.scope.kind === 'skill'
        ? `skill:${l.scope.skillSlug}`
        : `campaign:${l.scope.campaignId.slice(0, 8)}`;
  const pendingMarker = l.status === 'proposed' ? ' [pending ratification]' : '';
  return `- ${l.learningId} [${l.kind}, ${scopeLabel}, ${l.confidence}]${pendingMarker} ${l.statement}`;
}

/**
 * Render the durable-learnings block for the Coach prompt. Returns the
 * empty string when there are no learnings to surface (so the prompt
 * stays compact).
 */
export function formatLearningsForPrompt(
  learnings: CoachLearning[],
  setState?: LearningSetStateForPrompt,
): string {
  if (learnings.length === 0) return '';
  const lines = learnings.slice(0, 20).map(formatLearningLine);
  const setStateLine = setState
    ? [
        '',
        `Active injected set: ${String(setState.activeSetSize)} of budget ${String(setState.budget)}${
          setState.consolidationDue
            ? ' — over budget, consolidation due (learner.learning.consolidate)'
            : ''
        }.`,
      ]
    : [];
  return [
    '## Durable learnings (read-only context — what we have learned so far)',
    '',
    'These are auto-recorded campaign learnings + operator-ratified skill / space learnings. Take them into account when diagnosing. Do not re-record an identical learning; use `supersedes` if you are replacing one. Each line leads with the learning id — the id that `supersedes` and `learner.learning.consolidate` take.',
    ...setStateLine,
    '',
    ...lines,
  ].join('\n');
}
