import { describe, expect, it } from 'vitest';
import {
  alwaysGenerates,
  describeAnswerSource,
  type SimulationEndpointReport,
} from './use-simulations';

function report(over: Partial<SimulationEndpointReport> = {}): SimulationEndpointReport {
  return {
    endpointId: 'getPurchase',
    readiness: 'world_ready',
    declaredStatusClasses: ['2xx'],
    hasEffect: false,
    hasRule: false,
    diagnostics: [],
    ...over,
  };
}

describe('describeAnswerSource', () => {
  it('reports both rungs when both are declared, rather than picking a winner', () => {
    // A rule matches on args, ordinal and world state, so declaring one does
    // not mean it fires. Naming only the rule would promise an outcome the
    // artifact cannot guarantee.
    expect(describeAnswerSource(report({ hasRule: true, hasEffect: true }))).toBe('Rules + world');
  });

  it('names the effect when there is no rule', () => {
    expect(describeAnswerSource(report({ hasEffect: true }))).toBe('World effect');
  });

  it('says an endpoint with nothing declared has generation only', () => {
    expect(describeAnswerSource(report({ readiness: 'contract_ready' }))).toBe('Generation only');
  });

  it('does not claim an unanswerable endpoint will be generated', () => {
    expect(describeAnswerSource(report({ readiness: 'not_ready' }))).toBe('Cannot be answered');
  });
});

describe('alwaysGenerates', () => {
  it('is true only when nothing is declared, so every call reaches a model', () => {
    expect(alwaysGenerates(report({ readiness: 'contract_ready' }))).toBe(true);
  });

  it('is false when an effect is declared, even though a missed read can still generate', () => {
    // The distinction the panel needs: "reaches a model every time" is a
    // property of the artifact; "reached a model this call" is journal data.
    expect(alwaysGenerates(report({ hasEffect: true }))).toBe(false);
  });

  it('is false for an endpoint that cannot be answered at all', () => {
    expect(alwaysGenerates(report({ readiness: 'not_ready' }))).toBe(false);
  });
});
