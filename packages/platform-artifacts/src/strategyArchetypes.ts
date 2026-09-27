import { z } from 'zod';
import {
  StrategyArchetypeIdSchema,
  RiskToleranceSchema,
  StrategyTargetsSchema,
  StrategyRiskBudgetSchema,
  type StrategyArchetypeId,
  type RiskTolerance,
} from '@aflow/schemas';

// ============================================================================
// Schema
// ============================================================================

/**
 * One risk-tolerance band's preset: a complete target allocation + risk budget.
 * Reuses the `StrategySpec` sub-schemas so a preset is, by construction, a valid
 * spec fragment (`assetClass` sums to 1 ± ε; all caps in [0, 1]).
 */
export const StrategyArchetypePresetSchema = z
  .object({
    targets: StrategyTargetsSchema,
    riskBudget: StrategyRiskBudgetSchema,
  })
  .strict();

export type StrategyArchetypePreset = z.infer<typeof StrategyArchetypePresetSchema>;

export const StrategyArchetypeSchema = z
  .object({
    id: StrategyArchetypeIdSchema,
    label: z.string().min(1),
    description: z.string().min(1),
    /** Suggested symbols (broad-index core + thematic satellites). */
    defaultUniverse: z.array(z.string().min(1)).min(1).max(50),
    /** Complete preset for each risk-tolerance band; all four are required. */
    presetsByRiskTolerance: z
      .record(RiskToleranceSchema, StrategyArchetypePresetSchema)
      .superRefine((presets, ctx) => {
        for (const tolerance of RiskToleranceSchema.options) {
          if (presets[tolerance] === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [tolerance],
              message: `missing preset for riskTolerance "${tolerance}"`,
            });
          }
        }
      }),
  })
  .strict();

export type StrategyArchetype = z.infer<typeof StrategyArchetypeSchema>;

// ============================================================================
// Raw entries
// ============================================================================

/**
 * Broad-index core (US equity + bonds + a gold diversifier) with a small
 * satellite sleeve, rebalanced on drift. Equity share rises and the bond ballast
 * falls as risk tolerance increases; drift bands widen with tolerance.
 */
const CORE_SATELLITE: StrategyArchetype = {
  id: 'core_satellite',
  label: 'Core–Satellite',
  description:
    'Broad-index core (e.g. SPY/QQQ for equity, AGG for bonds, GLD as a diversifier) plus a small thematic satellite sleeve. Drift-band rebalanced. A sensible default for a single diversified paper account.',
  defaultUniverse: ['SPY', 'QQQ', 'AGG', 'GLD'],
  presetsByRiskTolerance: {
    conservative: {
      targets: {
        assetClass: { equity: 0.4, bonds: 0.55, alternatives: 0.05 },
        sector: {},
        perPositionMaxPct: 0.15,
        cashFloorPct: 0.1,
      },
      riskBudget: {
        maxDrawdownStopPct: 0.1,
        maxSectorPct: 0.3,
        maxSinglePositionPct: 0.15,
        driftBandPct: 0.05,
      },
    },
    balanced: {
      targets: {
        assetClass: { equity: 0.6, bonds: 0.35, alternatives: 0.05 },
        sector: {},
        perPositionMaxPct: 0.2,
        cashFloorPct: 0.05,
      },
      riskBudget: {
        maxDrawdownStopPct: 0.15,
        maxSectorPct: 0.35,
        maxSinglePositionPct: 0.2,
        driftBandPct: 0.05,
      },
    },
    growth: {
      targets: {
        assetClass: { equity: 0.8, bonds: 0.15, alternatives: 0.05 },
        sector: {},
        perPositionMaxPct: 0.25,
        cashFloorPct: 0.03,
      },
      riskBudget: {
        maxDrawdownStopPct: 0.2,
        maxSectorPct: 0.4,
        maxSinglePositionPct: 0.25,
        driftBandPct: 0.07,
      },
    },
    aggressive: {
      targets: {
        assetClass: { equity: 0.9, bonds: 0.05, alternatives: 0.05 },
        sector: {},
        perPositionMaxPct: 0.3,
        cashFloorPct: 0.02,
      },
      riskBudget: {
        maxDrawdownStopPct: 0.25,
        maxSectorPct: 0.5,
        maxSinglePositionPct: 0.3,
        driftBandPct: 0.08,
      },
    },
  },
};

const RAW_ARCHETYPES: readonly StrategyArchetype[] = [CORE_SATELLITE];

// ============================================================================
// Validated, frozen registry
// ============================================================================

/**
 * Ordered registry of strategy archetypes, validated through
 * `StrategyArchetypeSchema` at module load.
 */
export const STRATEGY_ARCHETYPES: readonly StrategyArchetype[] = RAW_ARCHETYPES.map((entry) => {
  const result = StrategyArchetypeSchema.safeParse(entry);
  if (!result.success) {
    throw new Error(
      `Invalid strategy archetype "${entry.id}": ${result.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
});

const ARCHETYPE_BY_ID: Readonly<Record<string, StrategyArchetype>> = Object.freeze(
  STRATEGY_ARCHETYPES.reduce<Record<string, StrategyArchetype>>((acc, entry) => {
    if (acc[entry.id]) {
      throw new Error(`Duplicate strategy archetype id: ${entry.id}`);
    }
    acc[entry.id] = entry;
    return acc;
  }, {}),
);

// Build-time integrity check: the registry must cover every id the schema enum
// admits, so `getStrategyArchetype(id)` is total over `StrategyArchetypeId`.
for (const id of StrategyArchetypeIdSchema.options) {
  if (ARCHETYPE_BY_ID[id] === undefined) {
    throw new Error(`Strategy archetype registry is missing an entry for id "${id}"`);
  }
}

// ============================================================================
// Lookup + list
// ============================================================================

/** Fetch an archetype by id. Total over `StrategyArchetypeId` (asserted above). */
export function getStrategyArchetype(id: StrategyArchetypeId): StrategyArchetype {
  const entry = ARCHETYPE_BY_ID[id];
  if (entry === undefined) {
    throw new Error(`Unknown strategy archetype id: ${id}`);
  }
  return entry;
}

/** List all archetypes in registry order. */
export function listStrategyArchetypes(): readonly StrategyArchetype[] {
  return STRATEGY_ARCHETYPES;
}

/** The preset for a given archetype + risk tolerance. */
export function getArchetypePreset(
  id: StrategyArchetypeId,
  riskTolerance: RiskTolerance,
): StrategyArchetypePreset {
  const preset = getStrategyArchetype(id).presetsByRiskTolerance[riskTolerance];
  if (preset === undefined) {
    throw new Error(`Archetype "${id}" has no preset for riskTolerance "${riskTolerance}"`);
  }
  return preset;
}
