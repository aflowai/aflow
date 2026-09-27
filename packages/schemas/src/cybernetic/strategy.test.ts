import { describe, it, expect } from 'vitest';
import {
  StrategyArchetypeIdSchema,
  StrategySpecSchema,
  StrategyTargetsSchema,
  RiskToleranceSchema,
} from './strategy.js';

function validTargets() {
  return {
    assetClass: { equity: 0.6, bonds: 0.35, alternatives: 0.05 },
    sector: {},
    perPositionMaxPct: 0.2,
    cashFloorPct: 0.05,
  };
}

function validSpec() {
  return {
    version: 1,
    status: 'draft' as const,
    archetypeId: 'core_satellite' as const,
    objectives: {
      riskTolerance: 'balanced' as const,
      horizonMonths: 60,
      incomeVsGrowth: 0.5,
      themeTilts: [],
      exclusions: [],
    },
    universe: ['SPY', 'QQQ', 'AGG', 'GLD'],
    targets: validTargets(),
    riskBudget: {
      maxDrawdownStopPct: 0.15,
      maxSectorPct: 0.35,
      maxSinglePositionPct: 0.2,
      driftBandPct: 0.05,
    },
    rebalance: { cadence: 'on_drift' as const, maxOrdersPerRun: 10 },
    provenance: {
      deriveRunId: 'quant_runs/abc',
      validatedByQuantRunIds: [],
      dataAsOf: '2026-06-05T00:00:00.000Z',
    },
  };
}

describe('StrategyArchetypeIdSchema (§4.3)', () => {
  it('is a closed enum — v1 ships exactly one archetype', () => {
    expect(StrategyArchetypeIdSchema.options).toEqual(['core_satellite']);
  });

  it('rejects an unknown archetype id', () => {
    expect(StrategyArchetypeIdSchema.safeParse('momentum').success).toBe(false);
  });
});

describe('RiskToleranceSchema', () => {
  it('has the four ordered tolerance bands', () => {
    expect(RiskToleranceSchema.options).toEqual([
      'conservative',
      'balanced',
      'growth',
      'aggressive',
    ]);
  });
});

describe('StrategyTargetsSchema (§4.2)', () => {
  it('accepts assetClass weights that sum to ~1', () => {
    expect(StrategyTargetsSchema.safeParse(validTargets()).success).toBe(true);
  });

  it('defaults sector to {} when omitted', () => {
    const { sector, ...noSector } = validTargets();
    const parsed = StrategyTargetsSchema.parse(noSector);
    expect(parsed.sector).toEqual({});
  });

  it('rejects assetClass weights that do not sum to 1 (±0.01)', () => {
    const bad = { ...validTargets(), assetClass: { equity: 0.6, bonds: 0.2 } };
    const res = StrategyTargetsSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.includes('assetClass'))).toBe(true);
    }
  });

  it('rejects assetClass weights that over-allocate (sum > 1.01)', () => {
    const bad = { ...validTargets(), assetClass: { equity: 0.7, bonds: 0.4 } };
    expect(StrategyTargetsSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects unknown keys (.strict)', () => {
    const extra = { ...validTargets(), bogus: 1 };
    expect(StrategyTargetsSchema.safeParse(extra).success).toBe(false);
  });
});

describe('StrategySpecSchema (§4.2)', () => {
  it('parses a complete valid spec', () => {
    expect(StrategySpecSchema.safeParse(validSpec()).success).toBe(true);
  });

  it('requires a positive integer version', () => {
    expect(StrategySpecSchema.safeParse({ ...validSpec(), version: 0 }).success).toBe(false);
    expect(StrategySpecSchema.safeParse({ ...validSpec(), version: 1.5 }).success).toBe(false);
  });

  it('caps the universe at 50 symbols', () => {
    const tooMany = { ...validSpec(), universe: Array.from({ length: 51 }, (_, i) => `S${i}`) };
    expect(StrategySpecSchema.safeParse(tooMany).success).toBe(false);
  });

  it('rejects unknown top-level keys (.strict)', () => {
    expect(StrategySpecSchema.safeParse({ ...validSpec(), signals: [] }).success).toBe(false);
  });
});
