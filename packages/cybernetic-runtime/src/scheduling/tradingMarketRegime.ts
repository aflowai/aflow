import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import {
  registerRuntimeValidator,
  registerValidator,
  type RuntimeValidatorContext,
  type RuntimeValidatorIssue,
} from '@aflow/schemas';
import {
  campaignRegimeCapIssues,
  marketRegimeIssues,
  regimeCapIssues,
  regimeCapsApply,
} from '@aflow/platform-artifacts';
import { listCampaigns } from '../campaigns.js';
import { activeCampaignNamed, loadWorkflowRunSlug } from './tradingCampaignArms.js';

/**
 * The Daily Trading Cycle's market regime. The gather-regime output carries
 * the closes it read and the regime they give, and this rule recomputes the
 * regime from the closes, so no derived number is the agent's own. The refs
 * are spelled here, not read from the skill at load, because suites that
 * mock `@aflow/platform-artifacts` still load this module.
 */
export const TRADING_MARKET_REGIME_VALIDATOR_REF = 'trading.market-regime' as const;

/**
 * The decide output's per-regime caps: a decision that opens theses stays
 * under the gross exposure cap and takes a bias the campaign allows for the
 * regime state it was made under. The caps are read from the campaign.
 */
export const TRADING_REGIME_CAPS_VALIDATOR_REF = 'trading.regime-caps' as const;

/** Campaign start: no regime cap above the campaign-wide gross exposure cap. */
export const TRADING_CAMPAIGN_REGIME_CAPS_VALIDATOR_REF = 'trading.campaign-regime-caps' as const;

function issuesOf(
  check: (data: unknown) => Array<{ path: Array<string | number>; message: string }>,
) {
  return z.unknown().superRefine((data, ctx) => {
    for (const issue of check(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
    }
  });
}

registerValidator(
  TRADING_MARKET_REGIME_VALIDATOR_REF,
  issuesOf((data) => marketRegimeIssues(data)),
);
registerValidator(
  TRADING_CAMPAIGN_REGIME_CAPS_VALIDATOR_REF,
  issuesOf((data) => campaignRegimeCapIssues(data)),
);

const DecideCampaignSchema = z.object({ regimeName: z.string() }).passthrough();

function refusal(message: string): RuntimeValidatorIssue[] {
  return [{ code: 'custom', path: ['regimeName'], message }];
}

/**
 * A decision held to a regime cap reads it from the running skill's active
 * campaign of its regimeName, and is refused when there is none: a cap that
 * cannot be read admits no thesis. A decision that opens nothing, or one made
 * with the regime unavailable, reads no campaign and passes.
 */
async function regimeCapsValidator(
  data: unknown,
  ctx: RuntimeValidatorContext,
): Promise<RuntimeValidatorIssue[]> {
  if (!regimeCapsApply(data)) return [];
  const parsed = DecideCampaignSchema.safeParse(data);
  if (!parsed.success) return [];
  const db = ctx.db as PostgresJsDatabase;
  const workflowSlug = ctx.workflowRunId
    ? await loadWorkflowRunSlug(db, ctx.tenantId, ctx.workflowRunId)
    : null;
  if (workflowSlug === null) {
    return refusal(
      'This output does not come from a workflow run the platform can read, so no regime cap can be read and no thesis can be formed.',
    );
  }
  const active = await listCampaigns(db, ctx.tenantId, {
    spaceId: ctx.spaceId,
    workflowSlug,
    status: 'active',
    limit: 100,
  });
  const { regimeName } = parsed.data;
  const campaign = activeCampaignNamed(active, { workflowSlug, regimeName });
  if (!campaign) {
    return refusal(
      `The skill "${workflowSlug}" has no active campaign with the regimeName "${regimeName}" in this space, so no regime cap can be read and no thesis can be formed.`,
    );
  }
  return regimeCapIssues(data, campaign.config?.['regimeCaps']).map((issue) => ({
    code: 'custom' as const,
    ...issue,
  }));
}

registerRuntimeValidator(TRADING_REGIME_CAPS_VALIDATOR_REF, regimeCapsValidator);
