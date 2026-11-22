import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import {
  readForValidator,
  registerRuntimeValidator,
  registerValidator,
  RuntimeValidatorFault,
  type RuntimeValidatorContext,
  type RuntimeValidatorIssue,
} from '@aflow/schemas';
import {
  campaignRegimeCapIssues,
  marketRegimeIssues,
  regimeCapIssues,
  regimeCapsApply,
  RegimeCapsSchema,
} from '@aflow/platform-artifacts';
import type { PayloadStore } from '@aflow/payload-store';
import { listCampaigns } from '../campaigns.js';
import { decodeTaskOutput } from '../humanTaskHydration.js';
import { loadRunById } from '../ledger.js';
import { activeCampaignNamed, loadWorkflowRunSlug } from './tradingCampaignArms.js';

/**
 * The Daily Trading Cycle's market regime. The gather-regime output carries
 * the index and member series it reported and the regime they give. This
 * rule holds each index series bar for bar to the run's read-index-bars
 * output, each member series to its read-universe-bars output, and
 * recomputes the regime from the closes, so no close and no derived number
 * is the agent's own. The refs are spelled here, not read from the skill at
 * load, because suites that mock `@aflow/platform-artifacts` still load this
 * module.
 */
export const TRADING_MARKET_REGIME_VALIDATOR_REF = 'trading.market-regime' as const;

/** The reads the series are held to, spelled here for the same reason as the refs. */
export const TRADING_INDEX_READ_TASK_ID = 'read-index-bars' as const;
export const TRADING_UNIVERSE_READ_TASK_ID = 'read-universe-bars' as const;

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

interface RegimeReads {
  index: unknown;
  universe: unknown;
}

/**
 * The read-index-bars and read-universe-bars outputs of the workflow run that
 * produced `data`. Each is null when the run holds none: no run, no succeeded
 * read, or a read that recorded no output. A null read refuses every series
 * it backs, so a regime is never gathered from closes the platform cannot
 * check. A read the DB fails raises a `RuntimeValidatorFault`. So does a
 * recorded output the payload store does not return: `decodeTaskOutput`
 * answers null for a store it cannot reach, and that is infrastructure, not
 * an absent read.
 */
async function loadRegimeReads(ctx: RuntimeValidatorContext): Promise<RegimeReads> {
  const { workflowRunId } = ctx;
  if (!workflowRunId) return { index: null, universe: null };
  const refs = await readForValidator(TRADING_MARKET_REGIME_VALIDATOR_REF, async () => {
    const run = await loadRunById(
      ctx.db as PostgresJsDatabase,
      ctx.tenantId,
      ctx.spaceId,
      workflowRunId,
    );
    const refOf = (taskId: string) =>
      run?.tasks.find((t) => t.taskId === taskId && t.status === 'succeeded')?.outputRef ?? null;
    return {
      index: refOf(TRADING_INDEX_READ_TASK_ID),
      universe: refOf(TRADING_UNIVERSE_READ_TASK_ID),
    };
  });
  const decode = async (taskId: string, outputRef: string | null): Promise<unknown> => {
    if (outputRef === null) return null;
    const read = await decodeTaskOutput(outputRef, ctx.payloadStore as PayloadStore | undefined);
    if (read === null) {
      throw new RuntimeValidatorFault(
        TRADING_MARKET_REGIME_VALIDATOR_REF,
        `the payload store returned no ${taskId} output for ${outputRef}`,
      );
    }
    return read;
  };
  return {
    index: await decode(TRADING_INDEX_READ_TASK_ID, refs.index),
    universe: await decode(TRADING_UNIVERSE_READ_TASK_ID, refs.universe),
  };
}

async function marketRegimeValidator(
  data: unknown,
  ctx: RuntimeValidatorContext,
): Promise<RuntimeValidatorIssue[]> {
  const reads = await loadRegimeReads(ctx);
  return marketRegimeIssues(data, reads.index, reads.universe).map((issue) => ({
    code: 'custom' as const,
    ...issue,
  }));
}

registerRuntimeValidator(TRADING_MARKET_REGIME_VALIDATOR_REF, marketRegimeValidator);
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
  const db = ctx.db as PostgresJsDatabase;
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
