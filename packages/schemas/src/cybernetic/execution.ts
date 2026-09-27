import { z } from 'zod';

// ============================================================================
// Order sizing — broker-neutral
// ============================================================================

/**
 * How much to trade, expressed without broker specifics. Rebalance paths
 * resolve shares (`qty`); discretionary "trim by $X" paths use `notional`.
 * Lowered to Alpaca `qty | notional` inside `execute-trade`.
 */
export const ProposedOrderSizingSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('qty'),
      qty: z.number().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('notional'),
      notional: z.number().positive(),
    })
    .strict(),
]);

export type ProposedOrderSizing = z.infer<typeof ProposedOrderSizingSchema>;

// ============================================================================
// ProposedOrder
// ============================================================================

/** A single order in a proposed set. Array order IS submit order (§7.0). */
export const ProposedOrderSchema = z
  .object({
    /**
     * Deterministic, set at propose time — the idempotency key for
     * exactly-once retry. Lowered to Alpaca `client_order_id`. Discretionary:
     * assigned by `intake`. Rebalance: `hash(strategyVersion, runId, symbol,
     * side)`, stable across retries.
     */
    clientOrderId: z.string().min(1),
    symbol: z.string().min(1),
    side: z.enum(['buy', 'sell']),
    sizing: ProposedOrderSizingSchema,
    orderType: z.enum(['market', 'limit', 'stop', 'stop_limit']),
    limitPrice: z.number().positive().optional(),
    stopPrice: z.number().positive().optional(),
    timeInForce: z.enum(['day', 'gtc']),
    /** Price the sizing was computed against — the drift-gate + ordering input. */
    refPrice: z.number().positive(),
    /** Code-computed estimate at `refPrice` (approval display + sells-before-buys ordering). */
    estNotional: z.number().positive(),
    rationale: z.string(),
  })
  .strict();

export type ProposedOrder = z.infer<typeof ProposedOrderSchema>;

// ============================================================================
// Post-trade projection (optional, code-computed)
// ============================================================================

export const PostTradeProjectionSchema = z
  .object({
    cashAfterPct: z.number(),
    perPositionAfter: z.record(z.string(), z.number()),
    sectorAfter: z.record(z.string(), z.number()),
  })
  .strict();

export type PostTradeProjection = z.infer<typeof PostTradeProjectionSchema>;

// ============================================================================
// ProposedOrderSet
// ============================================================================

/**
 * The execution seam. Produced by the discretionary path (`intake`, 1 order)
 * or the strategy path (`compute-orders`, N orders); consumed by
 * `execute-trade`. `source` discriminates intent; `strategyVersion` is present
 * iff `source === 'strategy_rebalance'`.
 */
export const ProposedOrderSetSchema = z
  .object({
    source: z.enum(['discretionary', 'strategy_rebalance']),
    /** Present iff `source === 'strategy_rebalance'` — pins the spec version. */
    strategyVersion: z.number().int().positive().optional(),
    rationale: z.string(),
    /** Snapshot time the sizing + projection were computed against (drift-gate input). */
    pricedAt: z.string().datetime(),
    /** 1 for discretionary, N for rebalance — array order IS submit order (sells before buys). */
    orders: z.array(ProposedOrderSchema).min(1),
    postTradeProjection: PostTradeProjectionSchema.optional(),
  })
  .strict()
  .superRefine((set, ctx) => {
    if (set.source === 'strategy_rebalance' && set.strategyVersion === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['strategyVersion'],
        message: 'strategyVersion is required when source is strategy_rebalance',
      });
    }
    if (set.source === 'discretionary' && set.strategyVersion !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['strategyVersion'],
        message: 'strategyVersion must be absent when source is discretionary',
      });
    }
  });

export type ProposedOrderSet = z.infer<typeof ProposedOrderSetSchema>;
