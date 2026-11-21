/** The run state a Daily Trading Cycle promotes: the cycle identity and what it recorded. */
export const CYCLE_STATE_VARIABLES = [
  {
    variableId: 'tradingDay',
    name: 'Trading day',
    description: 'The exchange-local trading day this cycle belongs to (YYYY-MM-DD).',
    required: false,
    sensitive: false,
    immutable: false,
  },
  {
    variableId: 'slot',
    name: 'Cycle slot',
    description:
      'Which slot of the trading day this cycle covered (pre_market / open / intraday / after_close).',
    required: false,
    sensitive: false,
    immutable: false,
  },
  {
    variableId: 'cycleCompleted',
    name: 'Cycle completed',
    description:
      '1 when the cycle was appended to the thesis ledger; absent on a duplicate-trigger no-op.',
    required: false,
    sensitive: false,
    immutable: false,
  },
  {
    variableId: 'thesesOpened',
    name: 'Theses opened',
    description: 'New theses written to the ledger this cycle.',
    required: false,
    sensitive: false,
    immutable: false,
  },
  {
    variableId: 'thesesResolved',
    name: 'Theses resolved',
    description:
      'Theses resolved (confirmed / falsified / expired / entry_failed / tactical_exit) this cycle.',
    required: false,
    sensitive: false,
    immutable: false,
  },
  {
    variableId: 'runSummary',
    name: 'Cycle summary',
    description: 'What this cycle resolved, opened, and executed.',
    required: false,
    sensitive: false,
    immutable: false,
  },
];
