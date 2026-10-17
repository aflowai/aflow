import { describe, expect, it } from 'vitest';
import {
  DECISION_MODEL_CAPABILITY_ID,
  LANE_CAPABILITY_PROVIDERS,
  describeMissingCapability,
  laneCapabilityTokensForTask,
} from '@aflow/schemas';
import { createDefaultModelCatalog } from './catalog.js';

describe('decision model readiness token', () => {
  it('is satisfied by exactly the providers of the catalog decision models', () => {
    const catalogProviders = new Set(
      createDefaultModelCatalog()
        .listModels()
        .filter((m) => m.capabilities.decision === true)
        .map((m) => m.provider),
    );
    expect(new Set(LANE_CAPABILITY_PROVIDERS[DECISION_MODEL_CAPABILITY_ID])).toEqual(
      catalogProviders,
    );
  });

  it('is required by a decision step and by nothing else in the ai lane', () => {
    expect(laneCapabilityTokensForTask({ operation: 'ai.decision.decide' })).toEqual([
      DECISION_MODEL_CAPABILITY_ID,
    ]);
    expect(laneCapabilityTokensForTask({ operation: 'ai.text.generate' })).toEqual([]);
  });

  it('names every provider that would close it', () => {
    const remedy = describeMissingCapability(DECISION_MODEL_CAPABILITY_ID);
    for (const provider of LANE_CAPABILITY_PROVIDERS[DECISION_MODEL_CAPABILITY_ID] ?? []) {
      expect(remedy).toContain(provider);
    }
  });
});
