import { getDatabase } from '@aflow/database';
import type { WorkflowCampaignStartInput, WorkflowCampaignStartOutput } from '@aflow/schemas';
import { startCampaign } from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from '../../types.js';
import { emitStepSuccess, emitStepError } from '../../helpers.js';
import { requireSpaceId } from '../../spaceScope.js';

/**
 * Validate `config` against the manifest contract (Ajv; structured per-field
 * errors) → `ensureActiveCampaign` on the instance identity → return the
 * campaign. Idempotent on identity: an existing active campaign with identical
 * config is returned as-is (`created: false`); differing non-identity config
 * errors with a pointer at `workflow.campaign.update` (no silent overwrite).
 */
export async function handleWorkflowCampaignStart(
  args: InlineHandlerArgs,
  input: WorkflowCampaignStartInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const db = getDatabase();
  const tenantIdStr = args.context.tenantId as string;

  const result = await startCampaign(db, tenantIdStr, {
    spaceId,
    slug: input.slug,
    ...(input.config ? { config: input.config } : {}),
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

  const output: WorkflowCampaignStartOutput = {
    campaign: result.campaign,
    created: result.created,
  };
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}
