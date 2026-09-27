import { describe, expect, it } from 'vitest';
import { SimulationRuleSchema, type SimulationRule } from '@aflow/schemas';
import { matchRule } from './rules.js';
import type { SimulatedRequest, WorldMutation, WorldStore } from './types.js';

const emptyWorld: WorldStore = {
  version: () => 1,
  stampOwnership: (mutations: readonly WorldMutation[]) => [...mutations],
  query: () => Promise.resolve([]),
  commit: () => Promise.resolve({ worldVersionAfter: 2, applied: true }),
};

/** A flat, ordered rule list — the shape that replaced named profiles. */
function rules(list: unknown[]): SimulationRule[] {
  return list.map((rule) => SimulationRuleSchema.parse(rule));
}

function request(overrides: Partial<SimulatedRequest> = {}): SimulatedRequest {
  return {
    method: 'POST',
    url: 'https://simulated.invalid/payments/refunds',
    endpointId: 'createRefund',
    params: { customerId: 'cus_1' },
    body: { orderId: 'ord_1', amount: 400 },
    ...overrides,
  };
}

function match(params: {
  rules?: SimulationRule[] | undefined;
  request?: SimulatedRequest;
  ordinal?: number;
}) {
  return matchRule({
    rules: params.rules ?? [],
    request: params.request ?? request(),
    ordinal: params.ordinal ?? 0,
    store: emptyWorld,
  });
}

describe('matchRule — endpoint', () => {
  it('matches the rule declared for this endpoint', async () => {
    const matched = await match({
      rules: rules([
        { ruleId: 'other', when: { endpointId: 'getCustomer' }, respond: { status: 200 } },
        { ruleId: 'refund-ok', when: { endpointId: 'createRefund' }, respond: { status: 201 } },
      ]),
    });

    expect(matched?.ruleId).toBe('refund-ok');
  });

  it('matches nothing when no rule names the endpoint', async () => {
    const matched = await match({
      rules: rules([
        { ruleId: 'other', when: { endpointId: 'getCustomer' }, respond: { status: 200 } },
      ]),
    });

    expect(matched).toBeUndefined();
  });
});

describe('matchRule — args', () => {
  it('matches when every declared pointer equals its value', async () => {
    const matched = await match({
      rules: rules([
        {
          ruleId: 'collections-hold',
          when: {
            endpointId: 'createRefund',
            args: [
              { path: '/params/customerId', equals: 'cus_1' },
              { path: '/body/amount', equals: 400 },
            ],
          },
          respond: { status: 409 },
        },
      ]),
    });

    expect(matched?.ruleId).toBe('collections-hold');
  });

  it('does not match when a pointer resolves to another value', async () => {
    const matched = await match({
      rules: rules([
        {
          ruleId: 'collections-hold',
          when: {
            endpointId: 'createRefund',
            args: [{ path: '/params/customerId', equals: 'cus_2' }],
          },
          respond: { status: 409 },
        },
      ]),
    });

    expect(matched).toBeUndefined();
  });

  it('does not match when a pointer resolves to nothing', async () => {
    const matched = await match({
      rules: rules([
        {
          ruleId: 'collections-hold',
          when: {
            endpointId: 'createRefund',
            args: [{ path: '/body/currency', equals: 'EUR' }],
          },
          respond: { status: 409 },
        },
      ]),
    });

    expect(matched).toBeUndefined();
  });
});

describe('matchRule — ordinal', () => {
  it('selects the Nth call to the endpoint and no other', async () => {
    const rateLimited = rules([
      {
        ruleId: 'third-call-429',
        when: { endpointId: 'createRefund', ordinal: 2 },
        respond: { status: 429 },
      },
    ]);

    const fired = await Promise.all(
      [0, 1, 2, 3].map(async (ordinal) => (await match({ rules: rateLimited, ordinal }))?.ruleId),
    );

    expect(fired).toEqual([undefined, undefined, 'third-call-429', undefined]);
  });

  it('applies a rule without an ordinal to every call', async () => {
    const golden = rules([
      { ruleId: 'golden-path', when: { endpointId: 'createRefund' }, respond: { status: 201 } },
    ]);

    const fired = await Promise.all(
      [0, 7].map(async (ordinal) => (await match({ rules: golden, ordinal }))?.ruleId),
    );

    expect(fired).toEqual(['golden-path', 'golden-path']);
  });
});

describe('matchRule — ordering', () => {
  it('returns the first matching rule in the list', async () => {
    const ordered = rules([
      { ruleId: 'first', when: { endpointId: 'createRefund' }, respond: { status: 429 } },
      { ruleId: 'second', when: { endpointId: 'createRefund' }, respond: { status: 201 } },
    ]);

    const matched = await match({ rules: ordered });

    expect(matched?.ruleId).toBe('first');
    expect(matched?.respond.status).toBe(429);
  });

  it('skips an earlier rule whose ordinal excludes it', async () => {
    const ordered = rules([
      {
        ruleId: 'first-call-only',
        when: { endpointId: 'createRefund', ordinal: 0 },
        respond: { status: 429 },
      },
      { ruleId: 'fallback', when: { endpointId: 'createRefund' }, respond: { status: 201 } },
    ]);

    expect((await match({ rules: ordered, ordinal: 0 }))?.ruleId).toBe('first-call-only');
    expect((await match({ rules: ordered, ordinal: 1 }))?.ruleId).toBe('fallback');
  });
});
