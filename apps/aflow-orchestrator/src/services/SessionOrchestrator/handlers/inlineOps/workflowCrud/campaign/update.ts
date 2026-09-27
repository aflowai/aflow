import { getDatabase } from '@aflow/database';
import type { WorkflowCampaignUpdateInput, WorkflowCampaignUpdateOutput } from '@aflow/schemas';
import { updateCampaign } from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from '../../types.js';
import { emitStepSuccess, emitStepError } from '../../helpers.js';
import { requireSpaceId } from '../../spaceScope.js';

/**
 * Mutate `mutable` non-identity config fields on an ACTIVE campaign. Identity
 * fields are rejected (different identity values are a different campaign).
 * Every effective change is ledger-stamped on `campaign.configHistory` so
 * trajectory readers can annotate the moved bar.
 */
export async function handleWorkflowCampaignUpdate(
  args: InlineHandlerArgs,
  input: WorkflowCampaignUpdateInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const db = getDatabase();
  const tenantIdStr = args.context.tenantId as string;

  const result = await updateCampaign(db, tenantIdStr, {
    spaceId,
    campaignId: input.campaignId,
    config: input.config,
  });
  if (!result.ok) {
    await emitStepError(
      args,
      result.code,
      result.message,
      startTime,
      'validation',
      false,
      result.details,
    );
    return;
  }

  const output: WorkflowCampaignUpdateOutput = {
    campaign: result.campaign,
    changedKeys: result.changedKeys,
  };
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}
