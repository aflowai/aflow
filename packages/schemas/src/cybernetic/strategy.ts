import { z } from 'zod';

// ============================================================================
// Archetype id — closed enum (§4.3)
// ============================================================================

/**
 * Closed enum of preset strategy archetypes. The agent **selects** an
 * archetype; it never authors one. New archetypes are a code change +
 * redeploy. v1 ships exactly one (`core_satellite`); the
 * `strategyArchetypes.ts` registry in `@aflow/platform-artifacts` supplies
 * each archetype's parameter template and is asserted to cover this enum.
 */
export const StrategyArchetypeIdSchema = z.enum(['core_satellite']);

export type StrategyArchetypeId = z.infer<typeof StrategyArchetypeIdSchema>;

// ============================================================================
// Sub-enums
// ============================================================================

export const StrategyStatusSchema = z.enum(['active', 'draft', 'retired']);
export type StrategyStatus = z.infer<typeof StrategyStatusSchema>;

export const RiskToleranceSchema = z.enum(['conservative', 'balanced', 'growth', 'aggressive']);
export type RiskTolerance = z.infer<typeof RiskToleranceSchema>;

export const RebalanceCadenceSchema = z.enum(['manual', 'weekly', 'monthly', 'on_drift']);
export type RebalanceCadence = z.infer<typeof RebalanceCadenceSchema>;

// ============================================================================
// Sub-objects
// ============================================================================

export const StrategyObjectivesSchema = z
  .object({
    riskTolerance: RiskToleranceSchema,
    horizonMonths: z.number().int().positive(),
    /** 0 = pure income, 1 = pure growth. */
    incomeVsGrowth: z.number().min(0).max(1),
    themeTilts: z.array(z.string().min(1)).max(20),
    exclusions: z.array(z.string().min(1)).max(50),
  })
  .strict();

export type StrategyObjectives = z.infer<typeof StrategyObjectivesSchema>;

export const StrategyTargetsSchema = z
  .object({
    /** Asset-class weights as fractions; sum ≈ 1 (±0.01). */
    assetClass: z.record(z.string(), z.number().min(0).max(1)),
    /** Optional sector targets/caps as fractions; empty when unset. */
    sector: z.record(z.string(), z.number().min(0).max(1)).default({}),
    perPositionMaxPct: z.number().min(0).max(1),
    cashFloorPct: z.number().min(0).max(1),
  })
  .strict()
  .refine(
    (t) => {
      const sum = Object.values(t.assetClass).reduce((a, b) => a + b, 0);
      return Math.abs(sum - 1) <= 0.01;
    },
    { message: 'targets.assetClass weights must sum to 1 (±0.01)', path: ['assetClass'] },
  );

export type StrategyTargets = z.infer<typeof StrategyTargetsSchema>;

export const StrategyRiskBudgetSchema = z
  .object({
    maxDrawdownStopPct: z.number().min(0).max(1),
    maxSectorPct: z.number().min(0).max(1),
    maxSinglePositionPct: z.number().min(0).max(1),
    /** Rebalance trigger when |actual − target| > band. */
    driftBandPct: z.number().min(0).max(1),
  })
  .strict();

export type StrategyRiskBudget = z.infer<typeof StrategyRiskBudgetSchema>;

export const StrategyRebalanceSchema = z
  .object({
    cadence: RebalanceCadenceSchema,
    maxOrdersPerRun: z.number().int().positive(),
  })
  .strict();

export type StrategyRebalance = z.infer<typeof StrategyRebalanceSchema>;

export const StrategyProvenanceSchema = z
  .object({
    /** Links to `quant_runs/{run_id}` — the derive run that produced the targets. */
    deriveRunId: z.string().min(1),
    /** Backtests supporting this version (advisory in v1). */
    validatedByQuantRunIds: z.array(z.string().min(1)).default([]),
    dataAsOf: z.string().datetime(),
  })
  .strict();

export type StrategyProvenance = z.infer<typeof StrategyProvenanceSchema>;

// ============================================================================
// StrategySpec
// ============================================================================

export const StrategySpecSchema = z
  .object({
    /** Monotonic; bumped on every activation. */
    version: z.number().int().positive(),
    status: StrategyStatusSchema,
    archetypeId: StrategyArchetypeIdSchema,
    objectives: StrategyObjectivesSchema,
    /** Symbols in scope (bounded). */
    universe: z.array(z.string().min(1)).max(50),
    targets: StrategyTargetsSchema,
    riskBudget: StrategyRiskBudgetSchema,
    rebalance: StrategyRebalanceSchema,
    provenance: StrategyProvenanceSchema,
  })
  .strict();

export type StrategySpec = z.infer<typeof StrategySpecSchema>;
