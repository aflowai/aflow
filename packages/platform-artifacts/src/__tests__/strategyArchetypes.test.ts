import { describe, it, expect } from 'vitest';
import { StrategyArchetypeIdSchema, RiskToleranceSchema } from '@aflow/schemas';
import {
  STRATEGY_ARCHETYPES,
  StrategyArchetypeSchema,
  getStrategyArchetype,
  listStrategyArchetypes,
  getArchetypePreset,
} from '../strategyArchetypes.js';

describe('strategy archetype registry (§4.3)', () => {
  it('covers every id in StrategyArchetypeIdSchema', () => {
    const ids = STRATEGY_ARCHETYPES.map((a) => a.id).sort();
    expect(ids).toEqual([...StrategyArchetypeIdSchema.options].sort());
  });

  it('v1 ships exactly the core_satellite archetype', () => {
    expect(STRATEGY_ARCHETYPES.map((a) => a.id)).toEqual(['core_satellite']);
  });

  it.each(STRATEGY_ARCHETYPES)('archetype "$id" re-parses against its schema', (archetype) => {
    expect(() => StrategyArchetypeSchema.parse(archetype)).not.toThrow();
  });

  it.each(STRATEGY_ARCHETYPES)(
    'archetype "$id" defines a preset for all four risk tolerances',
    (archetype) => {
      const bands = Object.keys(archetype.presetsByRiskTolerance).sort();
      expect(bands).toEqual([...RiskToleranceSchema.options].sort());
    },
  );

  it.each(STRATEGY_ARCHETYPES)(
    'archetype "$id" presets all have assetClass weights summing to ~1',
    (archetype) => {
      for (const tolerance of RiskToleranceSchema.options) {
        const preset = archetype.presetsByRiskTolerance[tolerance];
        const sum = Object.values(preset!.targets.assetClass).reduce((a, b) => a + b, 0);
        expect(Math.abs(sum - 1)).toBeLessThanOrEqual(0.01);
      }
    },
  );
});

describe('lookup helpers', () => {
  it('getStrategyArchetype is total over the enum', () => {
    for (const id of StrategyArchetypeIdSchema.options) {
      expect(getStrategyArchetype(id).id).toBe(id);
    }
  });

  it('listStrategyArchetypes returns the frozen registry', () => {
    expect(listStrategyArchetypes()).toBe(STRATEGY_ARCHETYPES);
  });

  it('getArchetypePreset returns the band-specific preset', () => {
    const conservative = getArchetypePreset('core_satellite', 'conservative');
    const aggressive = getArchetypePreset('core_satellite', 'aggressive');
    // Equity share rises with tolerance — a cheap monotonicity sanity check.
    expect(aggressive.targets.assetClass['equity']!).toBeGreaterThan(
      conservative.targets.assetClass['equity']!,
    );
  });
});
