import { getDatabase } from '@aflow/database';
import type { WorkflowCampaignRefreshInput, WorkflowCampaignRefreshOutput } from '@aflow/schemas';
import { listCampaigns, clearCampaignMemoEntries } from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from '../../types.js';
import { emitStepSuccess, emitStepError } from '../../helpers.js';
import { requireSpaceId } from '../../spaceScope.js';
import { getCampaignInSpace } from './shared.js';

/**
 * Clear campaign-scoped memo entries so `memo: 'campaign'` setup tasks
 * re-execute on the next run (replaces Kaggle's `forceRedownload` escape
 * hatch). Memo STORAGE lands in P5 — clearing is no-op-safe today and the op
 * surface is stable; P5 only changes what `clearCampaignMemoEntries` touches.
 */
export async function handleWorkflowCampaignRefresh(
  args: InlineHandlerArgs,
  input: WorkflowCampaignRefreshInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const db = getDatabase();
  const tenantIdStr = args.context.tenantId as string;

  let campaignId: string;
  if (input.campaignId !== undefined) {
    const campaign = await getCampaignInSpace(db, tenantIdStr, spaceId, input.campaignId);
    if (!campaign) {
      await emitStepError(
        args,
        'CAMPAIGN_NOT_FOUND',
        `No campaign found with id "${input.campaignId}" in this space.`,
        startTime,
        'validation',
      );
      return;
    }
    campaignId = campaign.campaignId;
  } else if (input.slug !== undefined) {
    const active = await listCampaigns(db, tenantIdStr, {
      spaceId,
      workflowSlug: input.slug,
      status: 'active',
    });
    if (active.length === 0) {
      await emitStepError(
        args,
        'CAMPAIGN_NOT_FOUND',
        `No active campaign exists for skill "${input.slug}" in this space.`,
        startTime,
        'validation',
      );
      return;
    }
    if (active.length > 1) {
      await emitStepError(
        args,
        'CAMPAIGN_AMBIGUOUS',
        `${String(active.length)} campaigns are active for skill "${input.slug}" — pass campaignId ` +
          `(candidates in error.details.activeCampaigns).`,
        startTime,
        'validation',
        false,
        {
          activeCampaigns: active.map((c) => ({
            campaignId: c.campaignId,
            goalRef: c.goalRef,
            ...(c.config !== undefined ? { config: c.config } : {}),
          })),
        },
      );
      return;
    }
    campaignId = active[0]!.campaignId;
  } else {
    // Unreachable when the input passed schema validation (refine requires
    // campaignId or slug) — guard for unvalidated inline dispatch.
    await emitStepError(
      args,
      'CAMPAIGN_REFRESH_TARGET_MISSING',
      'Pass campaignId or slug to workflow.campaign.refresh.',
      startTime,
      'validation',
    );
    return;
  }

  const clearedTaskIds = await clearCampaignMemoEntries(db, tenantIdStr, campaignId, input.taskIds);
  const output: WorkflowCampaignRefreshOutput = { campaignId, clearedTaskIds };
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}
