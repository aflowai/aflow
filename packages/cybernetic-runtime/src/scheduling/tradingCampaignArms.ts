import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import {
  registerRuntimeValidator,
  registerValidator,
  type RuntimeValidatorContext,
  type RuntimeValidatorIssue,
} from '@aflow/schemas';
import { listCampaigns } from '../campaigns.js';
import { loadThesisLedgerDocs, readLedgerTheses, type ThesisLedgerDoc } from './tradingArmTable.js';

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
  if (!parsed.success) return [];
  const { tradingDay, regimeName, theses } = parsed.data;
  const proposedIds = new Set(theses.map((t) => t.thesisId));
  const openedEarlier = new Map<string, number>();
  for (const thesis of readLedgerTheses(scope.docs)) {
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

async function campaignArmBudgets(
  ctx: RuntimeValidatorContext,
  regimeName: string,
): Promise<ArmBudget[] | null> {
  const active = await listCampaigns(ctx.db as PostgresJsDatabase, ctx.tenantId, {
    spaceId: ctx.spaceId,
    status: 'active',
    limit: 100,
  });
  const campaign = active.find((c) => c.config?.['regimeName'] === regimeName);
  const parsed = z
    .array(z.object({ id: z.string(), thesisBudgetPerDay: z.number() }))
    .safeParse(campaign?.config?.['hypotheses']);
  return parsed.success ? parsed.data : null;
}

async function thesisArmBudgetValidator(
  data: unknown,
  ctx: RuntimeValidatorContext,
): Promise<RuntimeValidatorIssue[]> {
  const parsed = DecideArmsSchema.safeParse(data);
  if (!parsed.success || parsed.data.theses.length === 0) return [];
  // The decide contract pins regimeName to the run's campaign, so a campaign
  // that cannot be found here is a platform fault, not the agent's to fix.
  const hypotheses = await campaignArmBudgets(ctx, parsed.data.regimeName);
  if (!hypotheses) return [];
  const docs = await loadThesisLedgerDocs(ctx.db as PostgresJsDatabase, ctx.tenantId, ctx.spaceId);
  return armBudgetIssues(data, { hypotheses, docs });
}

registerRuntimeValidator(TRADING_THESIS_ARM_BUDGET_VALIDATOR_REF, thesisArmBudgetValidator);
