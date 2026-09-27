import { getDatabase } from '@aflow/database';
import type {
  WorkflowCampaignGetInput,
  WorkflowCampaignGetOutput,
  WorkflowCampaignListInput,
  WorkflowCampaignListOutput,
  WorkflowCampaignView,
} from '@aflow/schemas';
import { getCampaignScoreSeries, listCampaigns } from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from '../../types.js';
import { emitStepSuccess, emitStepError } from '../../helpers.js';
import { requireSpaceId } from '../../spaceScope.js';
import {
  buildCampaignView,
  getCampaignInSpace,
  recentSeriesTail,
  summarizeScoreSeries,
} from './shared.js';

export async function handleWorkflowCampaignGet(
  args: InlineHandlerArgs,
  input: WorkflowCampaignGetInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const db = getDatabase();
  const tenantIdStr = args.context.tenantId as string;

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

  const series = await getCampaignScoreSeries(db, tenantIdStr, campaign.campaignId);
  const output: WorkflowCampaignGetOutput = {
    campaign,
    scoreSummary: summarizeScoreSeries(campaign, series),
    recentSeries: recentSeriesTail(series),
  };
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}

export async function handleWorkflowCampaignList(
  args: InlineHandlerArgs,
  input: WorkflowCampaignListInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const db = getDatabase();
  const tenantIdStr = args.context.tenantId as string;

  // Inline inputs arrive un-defaulted; 'active' mirrors the schema default.
  const { status = 'active' } = input as Partial<WorkflowCampaignListInput>;
  const campaigns = await listCampaigns(db, tenantIdStr, {
    spaceId,
    ...(input.slug !== undefined ? { workflowSlug: input.slug } : {}),
    ...(status !== 'all' ? { status } : {}),
  });

  const views: WorkflowCampaignView[] = [];
  for (const campaign of campaigns) {
    views.push(await buildCampaignView(db, tenantIdStr, campaign));
  }
  const output: WorkflowCampaignListOutput = { campaigns: views };
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}
