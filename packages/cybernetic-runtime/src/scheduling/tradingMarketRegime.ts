import type { Database } from '@aflow/database';
import { z } from 'zod';
import {
  readForValidator,
  registerRunDeriver,
  registerRuntimeValidator,
  registerValidator,
  type RuntimeValidatorContext,
  type RuntimeValidatorIssue,
} from '@aflow/schemas';
import {
  campaignRegimeCapIssues,
  gatherMarketRegime,
  reflectionTradingDay,
  regimeCapIssues,
  regimeCapsApply,
  RegimeCapsSchema,
} from '@aflow/platform-artifacts';
import { listCampaigns } from '../campaigns.js';
import { activeCampaignNamed, loadWorkflowRunSlug } from './tradingCampaignArms.js';

/**
 * The Daily Trading Cycle's market regime, computed by gather-regime through
 * `workflow.run.derive` from the run's read-index-bars and read-universe-bars
 * outputs and the exchange clock. No model transcribes a close or picks a
 * number. The refs are spelled here, not read from the skill at load,
 * because suites that mock `@aflow/platform-artifacts` still load this module.
 */
export const TRADING_MARKET_REGIME_DERIVER = 'trading.market-regime' as const;

registerRunDeriver(TRADING_MARKET_REGIME_DERIVER, (args) => {
  const derived = gatherMarketRegime(args);
  return derived.ok ? { ok: true, value: { ...derived.value } } : derived;
});

/**
 * The Trading Reflection's trading day, derived from the exchange clock its
 * ingest-clock task reads, so no caller and no model names the day.
 */
export const TRADING_REFLECTION_DAY_DERIVER = 'trading.reflection-day' as const;

registerRunDeriver(TRADING_REFLECTION_DAY_DERIVER, (args) => reflectionTradingDay(args));

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
 * cannot be read admits no thesis. A decision that opens nothing reads no
 * campaign and passes. One made with the regime unavailable opens nothing,
 * because its output schema refuses any thesis.
 */
async function regimeCapsValidator(
  data: unknown,
  ctx: RuntimeValidatorContext,
): Promise<RuntimeValidatorIssue[]> {
  if (!regimeCapsApply(data)) return [];
  const parsed = DecideCampaignSchema.safeParse(data);
  if (!parsed.success) return [];
  const db = ctx.db as Database;
  const { workflowRunId } = ctx;
  const workflowSlug = workflowRunId
    ? await readForValidator(TRADING_REGIME_CAPS_VALIDATOR_REF, () =>
        loadWorkflowRunSlug(db, ctx.tenantId, workflowRunId),
      )
    : null;
  if (workflowSlug === null) {
    return refusal(
      'This output does not come from a workflow run the platform can read, so no regime cap can be read and no thesis can be formed.',
    );
  }
  const active = await readForValidator(TRADING_REGIME_CAPS_VALIDATOR_REF, () =>
    listCampaigns(db, ctx.tenantId, {
      spaceId: ctx.spaceId,
      workflowSlug,
      status: 'active',
      limit: 100,
    }),
  );
  const { regimeName } = parsed.data;
  const campaign = activeCampaignNamed(active, { workflowSlug, regimeName });
  if (!campaign) {
    return refusal(
      `The skill "${workflowSlug}" has no active campaign with the regimeName "${regimeName}" in this space, so no regime cap can be read and no thesis can be formed.`,
    );
  }
  // Campaign start refuses a campaign without parseable regimeCaps, so none
  // reaches here. Caps that still do not parse are permanent: a resubmission
  // meets the same caps. So they refuse the output with an issue, never with
  // the transient fault a retry would answer.
  const regimeCaps = RegimeCapsSchema.safeParse(campaign.config?.['regimeCaps']);
  if (!regimeCaps.success) {
    const detail = regimeCaps.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return refusal(
      `The active campaign "${regimeName}" holds regimeCaps that do not parse (${detail}), so no regime cap can be read and no thesis can be formed. Submit theses: [], and the cycle's closes still run. The operator ends the campaign and starts one with valid regimeCaps.`,
    );
  }
  return regimeCapIssues(data, regimeCaps.data).map((issue) => ({
    code: 'custom' as const,
    ...issue,
  }));
}

registerRuntimeValidator(TRADING_REGIME_CAPS_VALIDATOR_REF, regimeCapsValidator);
