import { describe, it, expect } from 'vitest';
import { ProposedOrderSetSchema, ProposedOrderSizingSchema } from './execution.js';

function validOrder() {
  return {
    clientOrderId: 'ord-1',
    symbol: 'SPY',
    side: 'buy' as const,
    sizing: { kind: 'qty' as const, qty: 10 },
    orderType: 'market' as const,
    timeInForce: 'day' as const,
    refPrice: 500,
    estNotional: 5000,
    rationale: 'rebalance toward target',
  };
}

function discretionarySet() {
  return {
    source: 'discretionary' as const,
    rationale: 'trim winner',
    pricedAt: '2026-06-05T14:30:00.000Z',
    orders: [validOrder()],
  };
}

describe('ProposedOrderSizingSchema', () => {
  it('accepts a qty sizing', () => {
    expect(ProposedOrderSizingSchema.safeParse({ kind: 'qty', qty: 3 }).success).toBe(true);
  });

  it('accepts a notional sizing', () => {
    expect(ProposedOrderSizingSchema.safeParse({ kind: 'notional', notional: 250 }).success).toBe(
      true,
    );
  });

  it('rejects a qty/notional mismatch (discriminated union)', () => {
    expect(ProposedOrderSizingSchema.safeParse({ kind: 'qty', notional: 250 }).success).toBe(false);
  });

  it('rejects non-positive sizes', () => {
    expect(ProposedOrderSizingSchema.safeParse({ kind: 'qty', qty: 0 }).success).toBe(false);
  });
});

describe('ProposedOrderSetSchema (§4.4)', () => {
  it('parses a valid discretionary set with no strategyVersion', () => {
    expect(ProposedOrderSetSchema.safeParse(discretionarySet()).success).toBe(true);
  });

  it('parses a valid strategy_rebalance set with strategyVersion', () => {
    const set = {
      ...discretionarySet(),
      source: 'strategy_rebalance' as const,
      strategyVersion: 2,
    };
    expect(ProposedOrderSetSchema.safeParse(set).success).toBe(true);
  });

  it('rejects strategy_rebalance without strategyVersion', () => {
    const set = { ...discretionarySet(), source: 'strategy_rebalance' as const };
    const res = ProposedOrderSetSchema.safeParse(set);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.includes('strategyVersion'))).toBe(true);
    }
  });

  it('rejects discretionary WITH a strategyVersion', () => {
    const set = { ...discretionarySet(), strategyVersion: 1 };
    expect(ProposedOrderSetSchema.safeParse(set).success).toBe(false);
  });

  it('requires at least one order', () => {
    const set = { ...discretionarySet(), orders: [] };
    expect(ProposedOrderSetSchema.safeParse(set).success).toBe(false);
  });

  it('rejects unknown keys (.strict)', () => {
    const set = { ...discretionarySet(), bogus: true };
    expect(ProposedOrderSetSchema.safeParse(set).success).toBe(false);
  });
});
