import { getDatabase } from '@aflow/database';
import {
  getCampaignReader,
  type WorkflowCampaignReadInput,
  type WorkflowCampaignReadOutput,
} from '@aflow/schemas';
import type { InlineHandlerArgs } from '../../types.js';
import { emitStepSuccess, emitStepError } from '../../helpers.js';
import { requireSpaceId } from '../../spaceScope.js';
import { getCampaignInSpace } from './shared.js';

/**
 * Read a campaign's stored records through the reader the call names. The
 * reader reads the docs itself, so the value carries the records as stored
 * whatever their number, and no agent output has to hold them.
 */
export async function handleWorkflowCampaignRead(
  args: InlineHandlerArgs,
  input: WorkflowCampaignReadInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const db = getDatabase();
  const tenantIdStr = args.context.tenantId as string;

  const reader = getCampaignReader(input.reader);
  if (!reader) {
    await emitStepError(
      args,
      'CAMPAIGN_READER_UNKNOWN',
      `No campaign reader is registered as "${input.reader}".`,
      startTime,
      'validation',
    );
    return;
  }
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

  const result = await reader({
    tenantId: tenantIdStr,
    spaceId,
    workflowSlug: campaign.workflowSlug,
    config: campaign.config ?? {},
    startedAt: campaign.startedAt,
    // Inline inputs arrive un-defaulted, so absent args read as none.
    args: (input as Partial<WorkflowCampaignReadInput>).args ?? {},
    db,
    payloadStore: args.payloadStore,
  });
  if (!result.ok) {
    await emitStepError(args, 'CAMPAIGN_READ_REFUSED', result.message, startTime, 'validation');
    return;
  }
  const output: WorkflowCampaignReadOutput = {
    campaignId: campaign.campaignId,
    reader: input.reader,
    value: result.value,
  };
  await emitStepSuccess(args, output, startTime);
}
