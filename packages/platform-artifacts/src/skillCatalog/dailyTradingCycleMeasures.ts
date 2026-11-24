/**
 * The fields the Performance Review needs that the ledger could not give
 * before (Plan 343 Part E). Layer 2 compares equity with SPY buy-and-hold,
 * which needs SPY's close beside each after_close snapshot. Each arm's
 * expectancy in R needs every filled thesis's realized R, which needs its
 * entry and exit fill prices and its invalidation level. Each is recorded by
 * the step that reads it, and is null where that step cannot read it, so the
 * review reports a gap and never estimates one. The realized R is
 * recomputed from the doc's own prices by the trading.realized-r rule.
 */

export const BENCHMARK_SYMBOL = 'SPY';

const NULLABLE_PRICE = { type: ['number', 'null'], exclusiveMinimum: 0 };

/** resolve-theses: the close that confirmed an after_close tradingDay. */
export const RESOLVE_BENCHMARK_PROPERTY = {
  benchmarkClose: {
    ...NULLABLE_PRICE,
    description: `On after_close, the close of the ${BENCHMARK_SYMBOL} daily bar of tradingDay, the bar that confirmed it. null on every other slot, and where no such bar was read. The snapshot carries it as the Layer 2 benchmark.`,
  },
};

/** resolve-theses: each resolution's entry fill, from the per-order read. */
export const RESOLUTION_ENTRY_FILL_PROPERTY = {
  entryFillPrice: {
    ...NULLABLE_PRICE,
    description:
      'The broker’s filled average price of the thesis’s entry order, from the per-order read. null on entry_failed, and where the order read gives no fill price.',
  },
};

/** execute-orders: each order's fill price, from the same-cycle fill poll. */
export const ORDER_FILL_PRICE_PROPERTY = {
  filledAvgPrice: {
    ...NULLABLE_PRICE,
    description:
      'The broker’s filled average price from the fill poll. null when the order did not fill this run, or the poll gives none.',
  },
};

/** decide: the entry's levels ride onto the thesis, so its risk at entry is on the ledger. */
export const THESIS_LEVEL_PROPERTIES = {
  entryLevel: {
    type: 'number',
    exclusiveMinimum: 0,
    description: 'The level this thesis enters at.',
  },
  invalidationLevel: {
    type: 'number',
    exclusiveMinimum: 0,
    description:
      'The level this thesis is wrong at. Its distance from the entry fill is the thesis’s risk at entry.',
  },
};

/**
 * record: each resolved thesis's entry fill and realized R. The resolved doc
 * keeps the entry fill, so a close that settles in a later cycle still finds
 * every input its realized R needs.
 */
export const RECORDED_REALIZED_R_PROPERTY = {
  entryFillPrice: {
    ...NULLABLE_PRICE,
    description:
      'The resolution’s entryFillPrice, copied verbatim. The resolved doc keeps it, so a close that settles later computes realizedR from it.',
  },
  realizedR: {
    type: ['number', 'null'],
    description:
      'The thesis’s realized return over its risk at entry. A long: (exit fill − entry fill) ÷ (entry fill − invalidationLevel). A short: (entry fill − exit fill) ÷ (invalidationLevel − entry fill). null on entry_failed, and where the close has not filled at a known price. When the close settles in a later cycle, the record patches it onto the resolved doc from that doc’s entryFillPrice and invalidationLevel. The contract recomputes it from the doc’s prices and refuses another value.',
  },
};

export const RECORDED = Object.keys(RECORDED_REALIZED_R_PROPERTY);

/** The registered runtime validator that recomputes each resolved doc's realizedR. */
export const REALIZED_R_VALIDATOR_REF = 'trading.realized-r' as const;

/** Every rule the record contract runs: the arm table, the lens record and the realized R. */
export const RECORD_VALIDATOR_REFS = ['trading.arm-table', REALIZED_R_VALIDATOR_REF] as const;

/** record: the snapshot's benchmark, pinned to what resolve-theses read. */
export const SNAPSHOT_BENCHMARK_PROPERTY = {
  benchmarkClose: {
    type: ['number', 'null'],
    description: `${BENCHMARK_SYMBOL}'s close on tradingDay, copied from your input. It is pinned.`,
  },
};

/** record reads the benchmark resolve-theses read, so it can copy it into the snapshot. */
export const RECORD_BENCHMARK_BINDING = {
  benchmarkClose: {
    kind: 'task_output' as const,
    taskId: 'resolve-theses',
    path: 'benchmarkClose',
  },
};

export const SNAPSHOT_BENCHMARK_PIN = {
  bindingId: 'snapshot-benchmark-pin',
  from: 'resolve-theses',
  binding: 'value:$.benchmarkClose',
  target: '$.snapshotDoc.benchmarkClose.const',
};
