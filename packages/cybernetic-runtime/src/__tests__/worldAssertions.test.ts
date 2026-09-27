import { describe, it, expect } from 'vitest';
import { CaseExpectationSchema, type CaseExpectation } from '@aflow/schemas';

import { gradeCaseTrial, type GradableRunRecord } from '../evalTrialGrader.js';

/**
 * Plan 301 P1 — an assertion earns its place by accepting the reference AND
 * rejecting the defect it claims to catch. Every case here runs both
 * directions; an assertion that only accepts is the vacuous pass this plan
 * exists to stop.
 */

const DELTA = 'inline:delta';

/** One handover created against ORD-1001, for 120 SAR. The reference write. */
const REFERENCE_MUTATIONS = [
  {
    collection: 'handovers',
    op: 'create',
    entityId: 'HO-1',
    body: { order_ref: 'ORD-1001', amount: { value: 120, currency: 'SAR' } },
  },
];

function runWith(mutations: unknown[]): GradableRunRecord {
  return {
    status: 'paused',
    pausedReason: 'task_paused',
    pausedPayloadRef: 'inline:reply',
    tasks: [],
    simulationCalls: [
      {
        simulationId: 'cs-desk',
        endpointId: 'handover_start',
        responseStatus: 200,
        responseRef: null,
        deltaRef: DELTA,
        ordinal: 1,
      },
    ],
  };
}

function grade(check: unknown, mutations: unknown[]): boolean {
  const expectation: CaseExpectation = CaseExpectationSchema.parse({
    kind: 'simulation',
    simulationId: 'cs-desk',
    name: 'the handover',
    check,
  });
  const graded = gradeCaseTrial({
    expectations: [expectation],
    rubrics: [],
    fixtureTier: 'sealed',
    run: runWith(mutations),
    payloads: new Map<string, unknown>([[DELTA, { mutations }]]),
  });
  return graded.results.expectationResults[0]?.passed === true;
}

describe('entity-scoped assertions', () => {
  const check = { op: 'mutated', collection: 'handovers', change: 'create', entityId: 'HO-1' };

  it('accepts the reference', () => {
    expect(grade(check, REFERENCE_MUTATIONS)).toBe(true);
  });

  it('rejects a handover created against the wrong record', () => {
    // Before this, "a handover was created" passed on a handover opened for
    // somebody else's order — a different answer to the customer and the same
    // verdict to the suite.
    const wrongEntity = [{ ...REFERENCE_MUTATIONS[0], entityId: 'HO-9' }];
    expect(grade(check, wrongEntity)).toBe(false);
  });
});

describe('value-scoped assertions', () => {
  const check = {
    op: 'mutated',
    collection: 'handovers',
    change: 'create',
    where: [
      { path: '/order_ref', value: 'ORD-1001' },
      { path: '/amount/value', value: 120 },
    ],
  };

  it('accepts the reference', () => {
    expect(grade(check, REFERENCE_MUTATIONS)).toBe(true);
  });

  it('rejects the wrong order reference', () => {
    const wrongOrder = [
      { ...REFERENCE_MUTATIONS[0], body: { order_ref: 'ORD-2002', amount: { value: 120 } } },
    ];
    expect(grade(check, wrongOrder)).toBe(false);
  });

  it('rejects the wrong amount', () => {
    const wrongAmount = [
      { ...REFERENCE_MUTATIONS[0], body: { order_ref: 'ORD-1001', amount: { value: 999 } } },
    ];
    expect(grade(check, wrongAmount)).toBe(false);
  });

  it('reads a whole pointer, never a last segment that happens to match', () => {
    // `/amount/value` addresses the nested field. A top-level `value` sharing
    // its last segment is a different fact.
    const decoy = [
      { ...REFERENCE_MUTATIONS[0], body: { order_ref: 'ORD-1001', value: 120, amount: {} } },
    ];
    expect(grade(check, decoy)).toBe(false);
  });

  it('matches an id the agent typed as a string against one the world seeded as a number', () => {
    const numeric = [
      { ...REFERENCE_MUTATIONS[0], body: { order_ref: 'ORD-1001', amount: { value: '120' } } },
    ];
    expect(grade(check, numeric)).toBe(true);
  });
});

describe('count-scoped assertions', () => {
  const check = {
    op: 'mutated',
    collection: 'handovers',
    change: 'create',
    times: { exactly: 1 },
  };

  it('accepts exactly one', () => {
    expect(grade(check, REFERENCE_MUTATIONS)).toBe(true);
  });

  it('rejects a duplicate write', () => {
    // "A handover was created" is satisfied perfectly by a second handover.
    // Only a count separates an idempotent write from a duplicate one.
    const twice = [REFERENCE_MUTATIONS[0], { ...REFERENCE_MUTATIONS[0], entityId: 'HO-2' }];
    expect(grade(check, twice)).toBe(false);
  });

  it('rejects none when exactly one was claimed', () => {
    expect(grade(check, [{ collection: 'notes', op: 'create', entityId: 'N-1' }])).toBe(false);
  });

  it('supports a bounded range', () => {
    const twice = [REFERENCE_MUTATIONS[0], { ...REFERENCE_MUTATIONS[0], entityId: 'HO-2' }];
    expect(grade({ ...check, times: { atMost: 1 } }, twice)).toBe(false);
    expect(grade({ ...check, times: { atLeast: 2 } }, twice)).toBe(true);
  });
});

describe('the schema refuses a contradiction', () => {
  it('will not let times and expect: none say the same thing twice', () => {
    expect(() =>
      CaseExpectationSchema.parse({
        kind: 'simulation',
        check: {
          op: 'mutated',
          collection: 'handovers',
          expect: 'none',
          times: { exactly: 0 },
        },
      }),
    ).toThrow();
  });

  it('will not accept an empty times', () => {
    expect(() =>
      CaseExpectationSchema.parse({
        kind: 'simulation',
        check: { op: 'mutated', collection: 'handovers', times: {} },
      }),
    ).toThrow();
  });
});
