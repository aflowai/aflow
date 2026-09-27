import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { listCandidatesByCampaign, listPendingCandidatesBySkill } from './candidateLearnings.js';
import { formatCandidateLedgerForPrompt } from './candidateEvidence.js';

/**
 * Load and format the candidate ledger for the Coach review brief — the
 * campaign's full ledger (pending + negative evidence) when the review has a
 * campaign, otherwise the skill's pending process candidates. Best-effort — a
 * ledger load failure returns an empty string.
 */
export async function loadCandidateEvidenceForPrompt(params: {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  skillSlug: string;
  campaignId?: string | undefined;
  trajectory?: { direction: 'maximize' | 'minimize'; series: number[] } | undefined;
}): Promise<string> {
  try {
    const candidates = params.campaignId
      ? await listCandidatesByCampaign(params.db, params.tenantId, params.campaignId)
      : await listPendingCandidatesBySkill(params.db, params.tenantId, {
          spaceId: params.spaceId,
          skillSlug: params.skillSlug,
        });
    return formatCandidateLedgerForPrompt(
      candidates,
      params.trajectory ? { trajectory: params.trajectory } : {},
    );
  } catch {
    return '';
  }
}
