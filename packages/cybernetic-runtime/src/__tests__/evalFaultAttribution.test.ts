/**
 * Fault attribution: a failed OPERATION task is
 * never `fault=agent` — the agent is not in the loop. The motivating shape:
 * a market-briefing run failing on render-card's platform validation error
 * ("scope.spaceId is required for ui.artifact.render") must not score
 * `fault=agent, high` — that mis-blames the skill for an executor contract gap.
 */
import { describe, expect, it } from 'vitest';
import { classifyFault } from '../evalRunner.js';

const noCriteria = { goalResults: [], taskResults: {}, trajectoryResults: [] };

function task(overrides: Record<string, unknown>) {
  return {
    taskId: 'render-card',
    status: 'failed',
    durationMs: 0,
    costCents: 0,
    ...overrides,
  } as never;
}

describe('classifyFault — operation tasks are never agent fault', () => {
  it('the market-briefing shape: op validation failure → platform', () => {
    const fault = classifyFault(
      [
        task({
          operationId: 'ui.artifact.render',
          errorCode: 'VALIDATION_ERROR',
          errorClassification: 'validation',
        }),
      ],
      noCriteria,
    );
    expect(fault?.layer).toBe('platform');
    expect(fault?.evidence).toContain('ui.artifact.render');
  });

  it('provider/rate-limit/budget → environment; permission/configuration/not_found → configuration', () => {
    expect(
      classifyFault(
        [task({ operationId: 'api.http.call', errorClassification: 'provider' })],
        noCriteria,
      )?.layer,
    ).toBe('environment');
    expect(
      classifyFault(
        [task({ operationId: 'api.http.call', errorClassification: 'permission' })],
        noCriteria,
      )?.layer,
    ).toBe('configuration');
  });

  it('an op task failing with NO error class still never blames the agent', () => {
    expect(classifyFault([task({ operationId: 'workflow.learn' })], noCriteria)?.layer).toBe(
      'platform',
    );
  });

  it('a failed AGENT task (no operationId, no errorType) still attributes agent', () => {
    expect(classifyFault([task({})], noCriteria)?.layer).toBe('agent');
  });
});
