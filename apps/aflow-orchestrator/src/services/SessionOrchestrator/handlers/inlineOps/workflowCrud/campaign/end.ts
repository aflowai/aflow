import { getDatabase } from '@aflow/database';
import type { WorkflowCampaignEndInput, WorkflowCampaignEndOutput } from '@aflow/schemas';
import {
  endCampaignInSpace,
  getCyberneticLogger,
  maybeTriggerCampaignEndReview,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from '../../types.js';
import { emitStepSuccess, emitStepError } from '../../helpers.js';
import { requireSpaceId } from '../../spaceScope.js';

/** Idempotent: ending an already-ended campaign returns it unchanged. */
export async function handleWorkflowCampaignEnd(
  args: InlineHandlerArgs,
  input: WorkflowCampaignEndInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const db = getDatabase();
  const tenantIdStr = args.context.tenantId as string;

  // Inline inputs arrive un-defaulted; 'explicit' mirrors the schema default.
  const { reason = 'explicit' } = input as Partial<WorkflowCampaignEndInput>;
  const result = await endCampaignInSpace(db, tenantIdStr, {
    spaceId,
    campaignId: input.campaignId,
    reason,
  });
  if (!result.ok) {
    await emitStepError(args, result.code, result.message, startTime, 'validation');
    return;
  }

  if (result.endedNow) {
    // The campaign is already ended — a failed dispatch must not fail the op.
    try {
      await maybeTriggerCampaignEndReview({
        db,
        redis: args.redis,
        payloadStore: args.payloadStore,
        tenantId: tenantIdStr,
        spaceId,
        workflowSlug: result.campaign.workflowSlug,
        campaignId: input.campaignId,
        reason,
      });
    } catch (err) {
      getCyberneticLogger().warn(
        `[campaign.end] campaign-end review dispatch failed for campaign=${input.campaignId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const output: WorkflowCampaignEndOutput = { campaign: result.campaign };
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}
