import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  registerRuntimeValidator,
  registerValidator,
  type Campaign,
  type RuntimeValidatorContext,
  type RuntimeValidatorIssue,
  type TenantId,
} from '@aflow/schemas';
import { createTenantContext, withTenantSchema, workflowRuns } from '@aflow/database';
import { listCampaigns } from '../campaigns.js';
import {
  loadThesisLedgerDocs,
  readLedgerTheses,
  refusedLedgerDocIssues,
  type ThesisLedgerDoc,
} from './tradingArmTable.js';

/**
 * The rules between the fields of a multi-hypothesis trading campaign, run at
 * campaign start over the whole config. Each field's own JSON Schema cannot
 * see the others: an arm's daily budget is bounded by the campaign's day cap.
 */
export const TRADING_CAMPAIGN_ARMS_VALIDATOR_REF = 'trading.campaign-arms' as const;

/**
 * The decide task's per-arm daily budget. The theses a cycle forms for one
 * arm, with those the arm opened earlier that trading day, may not exceed the
 * arm's `thesisBudgetPerDay`. The budget is read from the campaign and the
 * earlier theses from the ledger, so no agent-reported count enters it.
 */
export const TRADING_THESIS_ARM_BUDGET_VALIDATOR_REF = 'trading.thesis-arm-budget' as const;

const CampaignArmsSchema = z
  .object({
    hypotheses: z.array(z.object({ id: z.string(), thesisBudgetPerDay: z.number() }).passthrough()),
    maxThesesPerDay: z.number(),
    minHorizonTradingDays: z.number(),
    maxHorizonTradingDays: z.number(),
    calibrationRule: z
      .object({ low: z.number(), medium: z.number(), high: z.number() })
      .passthrough(),
  })
  .passthrough()
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.hypotheses.forEach((arm, i) => {
      if (seen.has(arm.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['hypotheses', i, 'id'],
          message: `hypothesis id "${arm.id}" appears more than once. Every thesis cites one arm by id, so each arm needs its own.`,
        });
      }
      seen.add(arm.id);
      if (arm.thesisBudgetPerDay > config.maxThesesPerDay) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['hypotheses', i, 'thesisBudgetPerDay'],
          message: `arm "${arm.id}" has a thesisBudgetPerDay of ${String(arm.thesisBudgetPerDay)}, over the campaign's maxThesesPerDay of ${String(config.maxThesesPerDay)}. Lower the arm's budget or raise the cap.`,
        });
      }
    });
    if (config.minHorizonTradingDays > config.maxHorizonTradingDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minHorizonTradingDays'],
        message: `minHorizonTradingDays ${String(config.minHorizonTradingDays)} exceeds maxHorizonTradingDays ${String(config.maxHorizonTradingDays)}.`,
      });
    }
    const { low, medium, high } = config.calibrationRule;
    if (!(low < medium && medium < high)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['calibrationRule'],
        message: `the hit rates a stated confidence claims must rise from low to medium to high. They are ${String(low)}, ${String(medium)} and ${String(high)}.`,
      });
    }
  });

registerValidator(TRADING_CAMPAIGN_ARMS_VALIDATOR_REF, CampaignArmsSchema);

export interface ArmBudget {
  id: string;
  thesisBudgetPerDay: number;
}

const DecideArmsSchema = z
  .object({
    tradingDay: z.string(),
    regimeName: z.string(),
    theses: z.array(z.object({ thesisId: z.string(), hypothesisId: z.string() }).passthrough()),
  })
  .passthrough();

/**
 * A thesis already in the ledger under one of this output's thesisIds is the
 * same thesis re-proposed by a cycle re-run after a crash, so it does not
 * count against its own budget.
 */
export function armBudgetIssues(
  data: unknown,
  scope: { hypotheses: readonly ArmBudget[]; docs: readonly ThesisLedgerDoc[] },
): RuntimeValidatorIssue[] {
  const parsed = DecideArmsSchema.safeParse(data);
  // An output with no theses spends no budget, so it stays the way out of a
  // ledger the gate cannot count.
  if (!parsed.success || parsed.data.theses.length === 0) return [];
  const { tradingDay, regimeName, theses } = parsed.data;
  const ledger = readLedgerTheses(scope.docs);
  // A ledger doc that cannot be counted could hide an arm's earlier theses.
  if (ledger.refused.length > 0) return refusedLedgerDocIssues(ledger.refused, 'decide');
  const proposedIds = new Set(theses.map((t) => t.thesisId));
  const openedEarlier = new Map<string, number>();
  for (const thesis of ledger.theses) {
    if (thesis.regimeName !== regimeName || thesis.openedTradingDay !== tradingDay) continue;
    if (proposedIds.has(thesis.thesisId)) continue;
    openedEarlier.set(thesis.hypothesisId, (openedEarlier.get(thesis.hypothesisId) ?? 0) + 1);
  }
  const issues: RuntimeValidatorIssue[] = [];
  for (const arm of scope.hypotheses) {
    const earlier = openedEarlier.get(arm.id) ?? 0;
    const remaining = Math.max(0, arm.thesisBudgetPerDay - earlier);
    let cited = 0;
    theses.forEach((thesis, i) => {
      if (thesis.hypothesisId !== arm.id) return;
      cited += 1;
      if (cited !== remaining + 1) return;
      issues.push({
        code: 'custom',
        path: ['theses', i, 'hypothesisId'],
        message: `arm "${arm.id}" has a thesisBudgetPerDay of ${String(arm.thesisBudgetPerDay)} and opened ${String(earlier)} earlier on ${tradingDay}, so this cycle may form ${String(remaining)} for it. Drop the theses past that number, or cite them to an arm with budget left.`,
      });
    });
  }
  return issues;
}

const ArmBudgetsSchema = z
  .array(z.object({ id: z.string(), thesisBudgetPerDay: z.number() }).passthrough())
  .min(1);

/** The running skill's active campaign named `regimeName`, if there is one. */
export function activeCampaignNamed<C extends Pick<Campaign, 'config' | 'workflowSlug'>>(
  activeCampaigns: readonly C[],
  scope: { workflowSlug: string; regimeName: string },
): C | undefined {
  return activeCampaigns.find(
    (c) => c.workflowSlug === scope.workflowSlug && c.config?.['regimeName'] === scope.regimeName,
  );
}

/**
 * The arm budgets of the running skill's active campaign named `regimeName`,
 * or the issue that refuses the output when they cannot be read. Another
 * skill in the space, a forked copy of the cycle among them, may run a
 * campaign of the same name, so the skill's slug selects the campaign too. A
 * budget gate that cannot read its budgets refuses every thesis rather than
 * pass any number.
 */
export function campaignArmBudgets(
  activeCampaigns: ReadonlyArray<Pick<Campaign, 'config' | 'workflowSlug'>>,
  scope: { workflowSlug: string; regimeName: string },
): { ok: true; hypotheses: ArmBudget[] } | { ok: false; issue: RuntimeValidatorIssue } {
  const { workflowSlug, regimeName } = scope;
  const campaign = activeCampaignNamed(activeCampaigns, scope);
  if (!campaign) {
    return {
      ok: false,
      issue: {
        code: 'custom',
        path: ['regimeName'],
        message: `The skill "${workflowSlug}" has no active campaign with the regimeName "${regimeName}" in this space, so no arm budget can be read and no thesis can be formed. The decide contract pins regimeName to the run's campaign: a campaign ended mid-run ends its cycles too.`,
      },
    };
  }
  const parsed = ArmBudgetsSchema.safeParse(campaign.config?.['hypotheses']);
  if (!parsed.success) {
    return {
      ok: false,
      issue: {
        code: 'custom',
        path: ['regimeName'],
        message: `The campaign "${regimeName}" has no hypotheses list of { id, thesisBudgetPerDay }, so no arm budget can be read and no thesis can be formed. End the campaign and start a new one on the current skill version.`,
      },
    };
  }
  return { ok: true, hypotheses: parsed.data };
}

export async function loadWorkflowRunSlug(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<string | null> {
  const rows = await withTenantSchema(db, createTenantContext(tenantId as TenantId), (tx) =>
    tx
      .select({ workflowSlug: workflowRuns.workflowSlug })
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId))
      .limit(1),
  );
  return rows[0]?.workflowSlug ?? null;
}

async function thesisArmBudgetValidator(
  data: unknown,
  ctx: RuntimeValidatorContext,
): Promise<RuntimeValidatorIssue[]> {
  const parsed = DecideArmsSchema.safeParse(data);
  if (!parsed.success || parsed.data.theses.length === 0) return [];
  const db = ctx.db as PostgresJsDatabase;
  const workflowSlug = ctx.workflowRunId
    ? await loadWorkflowRunSlug(db, ctx.tenantId, ctx.workflowRunId)
    : null;
  if (workflowSlug === null) {
    return [
      {
        code: 'custom',
        path: ['regimeName'],
        message:
          'This output does not come from a workflow run the platform can read, so no campaign and no arm budget can be read and no thesis can be formed.',
      },
    ];
  }
  const active = await listCampaigns(db, ctx.tenantId, {
    spaceId: ctx.spaceId,
    workflowSlug,
    status: 'active',
    limit: 100,
  });
  const budgets = campaignArmBudgets(active, {
    workflowSlug,
    regimeName: parsed.data.regimeName,
  });
  if (!budgets.ok) return [budgets.issue];
  const docs = await loadThesisLedgerDocs(db, ctx.tenantId, ctx.spaceId);
  return armBudgetIssues(data, { hypotheses: budgets.hypotheses, docs });
}

registerRuntimeValidator(TRADING_THESIS_ARM_BUDGET_VALIDATOR_REF, thesisArmBudgetValidator);
