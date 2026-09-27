import type { SkillCatalogEntry } from '@aflow/schemas';
import { CATALOG_EPOCH } from './constants.js';
import {
  DAILY_CYCLE_RESOLVE_THESES_PROMPT,
  DAILY_CYCLE_DECIDE_PROMPT,
  DAILY_CYCLE_EXECUTE_ORDERS_PROMPT,
  DAILY_CYCLE_RECORD_PROMPT,
} from './dailyTradingCycleProse.js';

const CYCLE_PROCEED_GATE = {
  expression: 'tasks.resolve-theses.output.proceed == true',
  onMissingRef: 'skip' as const,
};

const DAILY_TRADING_CYCLE: SkillCatalogEntry = {
  catalogId: 'daily-trading-cycle',
  version: 1,
  name: 'Daily Trading Cycle',
  tagline:
    'Thesis-driven paper-trading cycle: resolve open theses, decide new ones, execute, record.',
  description: `One run = one trading-cycle slot on an Alpaca paper account. The unit of decision, measurement, and learning is the **thesis** — instrument + direction + rationale + falsification criterion + confirmation criterion + deadline + size, written and validated BEFORE any order exists. Each cycle resolves every open thesis against fill truth first, then its written criteria (confirmed / falsified / expired for filled entries; entry_failed otherwise), proposes new theses under the campaign's frozen regime hypothesis, executes the resulting orders (submitting only while the market is open — closed-market proposals defer as intentions), and appends everything to the thesis ledger under \`/portfolio/theses/\`.

**Campaign-driven**: the strategy regime lives in the campaign contract — regime name, ONE prose hypothesis, universe, theses/day cap, per-position and gross-exposure caps, horizon bounds, and the pre-registered evaluation window. The regime is frozen mid-campaign; strategy evolves at campaign boundaries via campaign-end synthesis and vetted learnings.

**Structural risk-gate, no human gate**: the campaign caps are bound into the decide task's output contract — a thesis outside the universe, over the size cap, past the horizon bounds, or breaching gross exposure (pending deferred intentions included) is rejected by schema validation and returned to the agent as a teaching error. Paper trading carries zero financial risk; the structural gate is the safety layer.

**Self-healing cadence**: runs are idempotent per (tradingDay, slot) via the ledger's cycle docs, and resolution always processes everything pending since the last completed cycle — a missed slot loses nothing and is recorded honestly in the cycle-reliability record.

**Two-layer measurement**: Layer-1 process metrics (cycle reliability, thesis discipline, resolution rate, calibration, loop health) derive from the ledger and are the primary signal. Layer-2 outcome metrics (benchmark-relative return, Sharpe, drawdown) are read only at pre-registered boundaries — raw daily P&L is not a signal anywhere.

**Prerequisites**: Alpaca paper API credentials configured once after bundle install; two schedules (shortly after the open, after the close) created by the operator.`,
  tags: ['alpaca', 'trading', 'paper', 'theses', 'campaigns'],
  bundle: {
    workflow: {
      slug: 'daily-trading-cycle',
      name: 'Daily Trading Cycle',
      description:
        'One thesis-driven trading cycle on the Alpaca paper account: ingest state, resolve open theses, decide new ones under campaign caps, execute orders, record the cycle to the ledger.',
      goal: 'Run one complete, honestly-recorded decision cycle per (tradingDay, slot): every open thesis evaluated against its written criteria, every new thesis fully specified and cap-validated before its order, every outcome appended to the thesis ledger with learnings extracted only from resolutions.',
      mode: 'process' as const,
      outcomes: [
        {
          id: 'cycle-recorded',
          name: 'Cycle recorded',
          evaluator: {
            type: 'threshold' as const,
            metric: 'cycleCompleted',
            operator: 'gte' as const,
            target: 1,
          },
        },
      ],
      tasks: [
        {
          taskId: 'ingest-clock',
          name: 'Ingest market clock',
          goal: 'Read the exchange clock — the timestamp anchors the trading day, the open/close boundaries decide the slot.',
          type: 'operation' as const,
          operation: 'api.http.call',
          retryability: 'safe' as const,
          inputTemplate: {
            apiId: 'alpaca-account-read',
            endpointId: 'get_clock',
            response: { format: 'json' },
          },
          outputProjection: {
            timestamp: { path: 'data.timestamp', onMissing: 'error' as const },
            isOpen: { path: 'data.is_open', onMissing: 'error' as const },
            nextOpen: { path: 'data.next_open', onMissing: 'error' as const },
            nextClose: { path: 'data.next_close', onMissing: 'error' as const },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['timestamp', 'isOpen', 'nextOpen', 'nextClose'],
              additionalProperties: false,
              properties: {
                timestamp: { type: 'string' },
                isOpen: { type: 'boolean' },
                nextOpen: { type: 'string' },
                nextClose: { type: 'string' },
              },
            },
          },
        },

        {
          taskId: 'ingest-account',
          name: 'Ingest account state',
          goal: 'Read account equity, cash, and buying power — the sizing base for every entry this cycle.',
          type: 'operation' as const,
          operation: 'api.http.call',
          retryability: 'safe' as const,
          dependsOn: ['ingest-clock'],
          inputTemplate: {
            apiId: 'alpaca-account-read',
            endpointId: 'get_account',
            response: { format: 'json' },
          },
          outputProjection: {
            equity: {
              path: 'data.equity',
              parse: ['number'] as const,
              onMissing: 'error' as const,
            },
            cash: { path: 'data.cash', parse: ['number'] as const, onMissing: 'error' as const },
            buyingPower: {
              path: 'data.buying_power',
              parse: ['number'] as const,
              onMissing: 'error' as const,
            },
            accountStatus: { path: 'data.status', onMissing: 'error' as const },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['equity', 'cash', 'buyingPower', 'accountStatus'],
              additionalProperties: false,
              properties: {
                equity: { type: 'number' },
                cash: { type: 'number' },
                buyingPower: { type: 'number' },
                accountStatus: { type: 'string' },
              },
            },
          },
        },

        {
          taskId: 'ingest-positions',
          name: 'Ingest open positions',
          goal: 'Read the live open positions — the source of truth for what is actually held.',
          type: 'operation' as const,
          operation: 'api.http.call',
          retryability: 'safe' as const,
          dependsOn: ['ingest-account'],
          inputTemplate: {
            apiId: 'alpaca-account-read',
            endpointId: 'get_positions',
            response: { format: 'json' },
          },
          outputProjection: {
            positions: { path: 'data', onMissing: 'error' as const },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['positions'],
              additionalProperties: false,
              properties: {
                positions: {
                  type: 'array',
                  items: { type: 'object', required: ['symbol'] },
                },
              },
            },
          },
        },

        {
          taskId: 'ingest-orders',
          name: 'Ingest open orders',
          goal: 'Read orders still open at the broker — entries or closes from prior cycles that have not filled.',
          type: 'operation' as const,
          operation: 'api.http.call',
          retryability: 'safe' as const,
          dependsOn: ['ingest-positions'],
          inputTemplate: {
            apiId: 'alpaca-account-read',
            endpointId: 'get_orders',
            params: { status: 'open' },
            response: { format: 'json' },
          },
          outputProjection: {
            openOrders: { path: 'data', onMissing: 'error' as const },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['openOrders'],
              additionalProperties: false,
              properties: {
                openOrders: { type: 'array', items: { type: 'object' } },
              },
            },
          },
        },

        {
          taskId: 'resolve-theses',
          name: 'Resolve open theses',
          goal: DAILY_CYCLE_RESOLVE_THESES_PROMPT,
          type: 'agent' as const,
          dependsOn: ['ingest-orders'],
          inputBindings: {
            clockTimestamp: {
              kind: 'task_output' as const,
              taskId: 'ingest-clock',
              path: 'timestamp',
            },
            marketIsOpen: { kind: 'task_output' as const, taskId: 'ingest-clock', path: 'isOpen' },
            nextOpen: { kind: 'task_output' as const, taskId: 'ingest-clock', path: 'nextOpen' },
            nextClose: { kind: 'task_output' as const, taskId: 'ingest-clock', path: 'nextClose' },
            equity: { kind: 'task_output' as const, taskId: 'ingest-account', path: 'equity' },
            positions: {
              kind: 'task_output' as const,
              taskId: 'ingest-positions',
              path: 'positions',
            },
            openOrders: {
              kind: 'task_output' as const,
              taskId: 'ingest-orders',
              path: 'openOrders',
            },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              // memory.store.put carries the market-data cache upsert.
              operations: ['memory.store.query', 'memory.store.get', 'memory.store.put'],
              integrations: [
                {
                  capabilityId: 'alpaca-market-data-default',
                  binding: { kind: 'binding' as const, bindingId: 'alpaca-market-data-default' },
                  sourceKind: 'api' as const,
                  integrationId: 'alpaca-market-data',
                  toolNames: [
                    { toolName: 'get_v2_stocks_snapshots' },
                    { toolName: 'get_v2_stocks_symbol_bars' },
                  ],
                  allTools: false,
                },
                // Fill truth: the open-orders input omits expired/cancelled/
                // rejected orders, so entry-fill state needs the per-order read.
                {
                  capabilityId: 'alpaca-account-read-default',
                  binding: { kind: 'binding' as const, bindingId: 'alpaca-account-read-default' },
                  sourceKind: 'api' as const,
                  integrationId: 'alpaca-account-read',
                  toolNames: [{ toolName: 'get_orders_order_id' }, { toolName: 'get_orders' }],
                  allTools: false,
                },
              ],
            },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: [
                'tradingDay',
                'slot',
                'proceed',
                'noopReason',
                'resolutions',
                'openThesesAfter',
                'pendingIntentions',
                'repairCloses',
                'orphanFlattens',
                'coverageNote',
              ],
              additionalProperties: false,
              properties: {
                tradingDay: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
                slot: { enum: ['morning', 'after_close'] },
                proceed: {
                  type: 'boolean',
                  description:
                    'False when this (tradingDay, slot) cycle is already recorded in the ledger or the derived date is not a trading day. Every downstream task is gated on this — a duplicate trigger no-ops.',
                },
                noopReason: { type: ['string', 'null'], maxLength: 500 },
                resolutions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: [
                      'thesisId',
                      'instrument',
                      'direction',
                      'outcome',
                      'entryFillState',
                      'evidence',
                      'statedConfidence',
                      'closePosition',
                      'closeQty',
                    ],
                    additionalProperties: false,
                    properties: {
                      thesisId: { type: 'string' },
                      instrument: { type: 'string' },
                      direction: { enum: ['long', 'short'] },
                      outcome: {
                        enum: ['confirmed', 'falsified', 'expired', 'entry_failed'],
                        description:
                          'Fill truth first: only a thesis whose entry order FILLED may resolve confirmed / falsified / expired. An entry that is unfilled, expired, cancelled, or rejected — or a deferred entry intention past the thesis deadline — resolves entry_failed: no position ever existed.',
                      },
                      entryFillState: {
                        enum: ['filled', 'partial', 'none'],
                        description:
                          'The entry’s fill truth as read from the broker. confirmed / falsified / expired are valid only with filled or partial; entry_failed only with none — the explicit assertion evals cross-check against broker data.',
                      },
                      evidence: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 1500,
                        description:
                          'Observed prices quoted against the written criterion — a resolution rests on data, never on a guess. For entry_failed: the order-state facts (status, expiry, rejection); the prediction outcome may be noted, but with no P&L attribution and no position narration.',
                      },
                      statedConfidence: { enum: ['low', 'medium', 'high'] },
                      closePosition: { type: 'boolean' },
                      closeQty: {
                        type: ['string', 'null'],
                        pattern: '^[0-9]+(\\.[0-9]+)?$',
                        description:
                          'The THESIS’s own filled entry quantity as a positive string, clamped to the currently held quantity — never negative (the broker reports shorts as negative qty) and never the symbol’s aggregate (two theses on one instrument would over-close and flip).',
                      },
                    },
                  },
                },
                openThesesAfter: { type: 'array', items: { type: 'string' } },
                pendingIntentions: {
                  type: 'array',
                  description:
                    'Deferred intentions that will still submit (entry intentions within their thesis deadline; all close intentions) — queued exposure the decide task folds into its projection.',
                  items: {
                    type: 'object',
                    required: ['thesisId', 'intent', 'symbol', 'qty', 'notional'],
                    additionalProperties: false,
                    properties: {
                      thesisId: { type: 'string' },
                      intent: { enum: ['open', 'close'] },
                      symbol: { type: 'string' },
                      qty: { type: ['string', 'null'] },
                      notional: { type: ['string', 'null'] },
                    },
                  },
                },
                repairCloses: {
                  type: 'array',
                  description:
                    'Held positions whose theses are already RESOLVED with closePosition true but whose resolved docs show no filled close — unclosed resolutions, never orphans. This cycle’s execution closes them; without this list a failed close would strand the position forever.',
                  items: {
                    type: 'object',
                    required: ['thesisId', 'instrument', 'qty'],
                    additionalProperties: false,
                    properties: {
                      thesisId: { type: 'string' },
                      instrument: { type: 'string' },
                      qty: {
                        type: 'string',
                        pattern: '^[0-9]+(\\.[0-9]+)?$',
                        description:
                          'The THESIS’s own filled entry quantity, clamped to the currently held quantity — never the symbol’s aggregate position, which over-closes and flips when two theses share an instrument.',
                      },
                    },
                  },
                },
                orphanFlattens: {
                  type: 'array',
                  description:
                    'Every held position that no open thesis, pending close, or repairCloses entry accounts for. This account is the agent’s alone to manage, so an orphan is never left for an operator — it is reconciled: flattened this cycle, back to a state where every position carries a thesis. Excluded from the cap-scored campaign gross (it is being cleared, not held as strategy).',
                  items: {
                    type: 'object',
                    required: ['symbol', 'qty', 'side', 'evidence'],
                    additionalProperties: false,
                    properties: {
                      symbol: { type: 'string' },
                      qty: {
                        type: 'string',
                        pattern: '^[0-9]+(\\.[0-9]+)?$',
                        description:
                          'Absolute held quantity — an orphan symbol carries no thesis position, so the symbol aggregate is the correct flatten size.',
                      },
                      side: { enum: ['long', 'short'] },
                      evidence: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 500,
                        description:
                          'What order history shows created this position (client order id and facts, or "provenance undetermined") — recorded so a surprising flatten is always auditable.',
                      },
                    },
                  },
                },
                coverageNote: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 1000,
                  description:
                    'Which pending slots this run covered, naming any missed (tradingDay, slot) since the last completed cycle — recorded honestly, never papered over.',
                },
              },
            },
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'tradingDay', toState: 'tradingDay' },
            { kind: 'output_path' as const, path: 'slot', toState: 'slot' },
          ],
        },

        {
          taskId: 'decide',
          name: 'Decide new theses',
          goal: DAILY_CYCLE_DECIDE_PROMPT,
          type: 'agent' as const,
          dependsOn: ['resolve-theses'],
          when: CYCLE_PROCEED_GATE,
          inputBindings: {
            tradingDay: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'tradingDay',
            },
            slot: { kind: 'task_output' as const, taskId: 'resolve-theses', path: 'slot' },
            resolutions: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'resolutions',
            },
            openThesesAfter: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'openThesesAfter',
            },
            repairCloses: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'repairCloses',
            },
            orphanFlattens: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'orphanFlattens',
            },
            pendingIntentions: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'pendingIntentions',
            },
            equity: { kind: 'task_output' as const, taskId: 'ingest-account', path: 'equity' },
            positions: {
              kind: 'task_output' as const,
              taskId: 'ingest-positions',
              path: 'positions',
            },
            hypothesis: { kind: 'campaign_input' as const, path: 'hypothesis' },
            universe: { kind: 'campaign_input' as const, path: 'universe' },
            maxThesesPerDay: { kind: 'campaign_input' as const, path: 'maxThesesPerDay' },
            maxPositionSizePct: { kind: 'campaign_input' as const, path: 'maxPositionSizePct' },
            maxGrossExposurePct: { kind: 'campaign_input' as const, path: 'maxGrossExposurePct' },
            minHorizonTradingDays: {
              kind: 'campaign_input' as const,
              path: 'minHorizonTradingDays',
            },
            maxHorizonTradingDays: {
              kind: 'campaign_input' as const,
              path: 'maxHorizonTradingDays',
            },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'active' as const,
            capabilities: {
              // Campaign-1 evidence classes are the tool surface: per-instrument
              // OHLCV + index context that is itself price data. No news tool —
              // later campaigns widen evidence by widening this grant.
              // memory.store.put carries the market-data cache upsert.
              operations: ['memory.store.get', 'memory.store.query', 'memory.store.put'],
              integrations: [
                {
                  capabilityId: 'alpaca-market-data-default',
                  binding: { kind: 'binding' as const, bindingId: 'alpaca-market-data-default' },
                  sourceKind: 'api' as const,
                  integrationId: 'alpaca-market-data',
                  toolNames: [
                    { toolName: 'get_v2_stocks_snapshots' },
                    { toolName: 'get_v2_stocks_symbol_bars' },
                  ],
                  allTools: false,
                },
              ],
            },
          },
          // The structural risk-gate: campaign caps land in this schema at
          // delegation time, so an out-of-cap thesis is a validation error the
          // agent must fix — not a rule it is asked to remember.
          outputContract: {
            schema: {
              type: 'object',
              required: ['theses', 'projectedGrossExposurePct', 'decisionRationale'],
              additionalProperties: false,
              properties: {
                theses: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: [
                      'thesisId',
                      'instrument',
                      'direction',
                      'rationale',
                      'falsificationCriterion',
                      'confirmationCriterion',
                      'deadlineTradingDays',
                      'sizePct',
                      'confidence',
                    ],
                    additionalProperties: false,
                    properties: {
                      thesisId: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{2,63}$' },
                      instrument: { type: 'string' },
                      direction: { enum: ['long', 'short'] },
                      rationale: { type: 'string', minLength: 1, maxLength: 1500 },
                      falsificationCriterion: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 500,
                        description:
                          'Price-checkable condition that proves the thesis wrong — a later cycle must be able to read prices and answer yes/no.',
                      },
                      confirmationCriterion: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 500,
                        description: 'Price-checkable condition that proves the thesis right.',
                      },
                      deadlineTradingDays: { type: 'integer', minimum: 1, maximum: 5 },
                      sizePct: { type: 'number', exclusiveMinimum: 0 },
                      confidence: { enum: ['low', 'medium', 'high'] },
                    },
                  },
                },
                projectedGrossExposurePct: {
                  type: 'number',
                  minimum: 0,
                  description:
                    'Thesis-attributed gross exposure (÷ equity × 100) after this cycle’s closes, the pending deferred intentions, and the proposed entries — orphan positions being flattened this cycle excluded, pending entries included: deferral never hides exposure from this cap.',
                },
                decisionRationale: { type: 'string', minLength: 1, maxLength: 1500 },
              },
            },
            derivedFrom: [
              {
                bindingId: 'universe-instruments',
                from: '$campaign',
                binding: 'enum:$.universe[*]',
                target: '$.theses.items.instrument.enum',
              },
              {
                bindingId: 'theses-per-day-cap',
                from: '$campaign',
                binding: 'value:$.maxThesesPerDay',
                target: '$.theses.maxItems',
              },
              {
                bindingId: 'position-size-cap',
                from: '$campaign',
                binding: 'value:$.maxPositionSizePct',
                target: '$.theses.items.sizePct.maximum',
              },
              {
                bindingId: 'gross-exposure-cap',
                from: '$campaign',
                binding: 'value:$.maxGrossExposurePct',
                target: '$.projectedGrossExposurePct.maximum',
              },
              {
                bindingId: 'horizon-floor',
                from: '$campaign',
                binding: 'value:$.minHorizonTradingDays',
                target: '$.theses.items.deadlineTradingDays.minimum',
              },
              {
                bindingId: 'horizon-ceiling',
                from: '$campaign',
                binding: 'value:$.maxHorizonTradingDays',
                target: '$.theses.items.deadlineTradingDays.maximum',
              },
            ],
          },
        },

        {
          taskId: 'execute-orders',
          name: 'Execute orders',
          goal: DAILY_CYCLE_EXECUTE_ORDERS_PROMPT,
          type: 'agent' as const,
          dependsOn: ['decide'],
          when: CYCLE_PROCEED_GATE,
          inputBindings: {
            tradingDay: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'tradingDay',
            },
            slot: { kind: 'task_output' as const, taskId: 'resolve-theses', path: 'slot' },
            marketIsOpen: { kind: 'task_output' as const, taskId: 'ingest-clock', path: 'isOpen' },
            resolutions: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'resolutions',
            },
            theses: { kind: 'task_output' as const, taskId: 'decide', path: 'theses' },
            repairCloses: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'repairCloses',
            },
            orphanFlattens: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'orphanFlattens',
            },
            equity: { kind: 'task_output' as const, taskId: 'ingest-account', path: 'equity' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              // The ONLY task in the skill with the orders-write grant. Its
              // inputs are the validated resolution/thesis arrays — every order
              // carries a pre-registered thesis by construction. Memory ops
              // carry the deferred-intentions ledger; the account read is the
              // same-cycle fill verification; the snapshot read prices
              // whole-share short sizing at submission time.
              operations: [
                'agent.control.signal_blocked',
                'memory.store.query',
                'memory.store.get',
                'memory.store.put',
                'memory.store.delete',
              ],
              integrations: [
                {
                  capabilityId: 'alpaca-paper-orders-write-default',
                  binding: {
                    kind: 'binding' as const,
                    bindingId: 'alpaca-paper-orders-write-default',
                  },
                  sourceKind: 'api' as const,
                  integrationId: 'alpaca-paper-orders-write',
                  toolNames: [{ toolName: 'post_orders' }, { toolName: 'delete_orders_order_id' }],
                  allTools: false,
                },
                {
                  capabilityId: 'alpaca-account-read-default',
                  binding: { kind: 'binding' as const, bindingId: 'alpaca-account-read-default' },
                  sourceKind: 'api' as const,
                  integrationId: 'alpaca-account-read',
                  toolNames: [{ toolName: 'get_orders_order_id' }, { toolName: 'get_orders' }],
                  allTools: false,
                },
                {
                  capabilityId: 'alpaca-market-data-default',
                  binding: { kind: 'binding' as const, bindingId: 'alpaca-market-data-default' },
                  sourceKind: 'api' as const,
                  integrationId: 'alpaca-market-data',
                  toolNames: [{ toolName: 'get_v2_stocks_snapshots' }],
                  allTools: false,
                },
              ],
            },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['orderResults', 'submittedCount', 'deferredCount', 'failedCount'],
              additionalProperties: false,
              properties: {
                orderResults: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: [
                      'clientOrderId',
                      'thesisId',
                      'intent',
                      'symbol',
                      'side',
                      'qty',
                      'notional',
                      'disposition',
                      'statusCode',
                      'orderId',
                      'orderStatus',
                      'fillState',
                      'error',
                    ],
                    additionalProperties: false,
                    properties: {
                      clientOrderId: { type: 'string' },
                      thesisId: { type: 'string' },
                      intent: { enum: ['open', 'close'] },
                      symbol: { type: 'string' },
                      side: { enum: ['buy', 'sell'] },
                      qty: {
                        type: ['string', 'null'],
                        description:
                          'Order quantity. A close submits the held quantity verbatim — fractional allowed, a long opened by notional holds fractional shares. A short entry is always whole shares: the broker rejects fractional short sales.',
                      },
                      notional: {
                        type: ['string', 'null'],
                        description:
                          'Dollar sizing — long entries; for a short entry, the target the whole-share qty was derived from.',
                      },
                      disposition: {
                        enum: ['submitted', 'duplicate', 'deferred', 'expired', 'failed'],
                        description:
                          'submitted = the broker acknowledged the order (2xx + order id). duplicate = the client order id already exists at the broker — found in the pre-submission orders list, or rejected as already used on submit; either way the prior submission stands, counted in neither submittedCount nor failedCount. deferred = market closed, recorded as an intention. expired = a pending entry intention dropped unsubmitted (thesis deadline passed, or no open-thesis doc behind it). failed = the broker rejected it (any other non-2xx), or the order could not be sized at all (a short entry whose share price exceeds its target — no broker call).',
                      },
                      statusCode: {
                        type: ['integer', 'null'],
                        description:
                          'HTTP status of the broker call; null when no call was made (deferred / expired / a failed order that could not be sized / a duplicate settled from the pre-submission orders list). The gate for disposition: only 2xx with an order id is submitted; a duplicate-id rejection is duplicate; anything else outside 2xx is failed — a plausible body never overrides the status.',
                      },
                      orderId: { type: ['string', 'null'] },
                      orderStatus: { type: ['string', 'null'] },
                      fillState: {
                        enum: ['filled', 'partial', 'pending', null],
                        description:
                          'Same-cycle fill verification, polled per submitted order; null when not submitted this run (deferred / expired / failed / duplicate — a duplicate’s fill truth is read by next cycle’s resolution).',
                      },
                      error: { type: ['string', 'null'] },
                    },
                  },
                },
                submittedCount: { type: 'integer', minimum: 0 },
                deferredCount: { type: 'integer', minimum: 0 },
                failedCount: { type: 'integer', minimum: 0 },
              },
            },
          },
        },

        {
          taskId: 'record',
          name: 'Record cycle',
          goal: DAILY_CYCLE_RECORD_PROMPT,
          type: 'agent' as const,
          dependsOn: ['execute-orders'],
          when: CYCLE_PROCEED_GATE,
          inputBindings: {
            tradingDay: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'tradingDay',
            },
            slot: { kind: 'task_output' as const, taskId: 'resolve-theses', path: 'slot' },
            coverageNote: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'coverageNote',
            },
            resolutions: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'resolutions',
            },
            theses: { kind: 'task_output' as const, taskId: 'decide', path: 'theses' },
            decisionRationale: {
              kind: 'task_output' as const,
              taskId: 'decide',
              path: 'decisionRationale',
            },
            projectedGrossExposurePct: {
              kind: 'task_output' as const,
              taskId: 'decide',
              path: 'projectedGrossExposurePct',
            },
            orderResults: {
              kind: 'task_output' as const,
              taskId: 'execute-orders',
              path: 'orderResults',
            },
            submittedCount: {
              kind: 'task_output' as const,
              taskId: 'execute-orders',
              path: 'submittedCount',
            },
            deferredCount: {
              kind: 'task_output' as const,
              taskId: 'execute-orders',
              path: 'deferredCount',
            },
            failedCount: {
              kind: 'task_output' as const,
              taskId: 'execute-orders',
              path: 'failedCount',
            },
            orphanFlattens: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'orphanFlattens',
            },
            equity: { kind: 'task_output' as const, taskId: 'ingest-account', path: 'equity' },
            cash: { kind: 'task_output' as const, taskId: 'ingest-account', path: 'cash' },
            positions: {
              kind: 'task_output' as const,
              taskId: 'ingest-positions',
              path: 'positions',
            },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'active' as const,
            capabilities: {
              operations: ['memory.store.get', 'memory.store.put', 'memory.store.delete'],
              integrations: [],
            },
          },
          // `learnings` is derived from record-learnings' workflow.learn input;
          // the derivedFrom cap makes "≤1 learning per resolution" structural —
          // zero resolutions ⇒ maxItems 0 ⇒ an invented learning cannot validate.
          outputContract: {
            schema: {
              type: 'object',
              required: [
                'runSummary',
                'cycleCompleted',
                'thesesOpened',
                'thesesResolved',
                'grossExposurePct',
                'brokerGrossExposurePct',
                'cycleDoc',
                'snapshotDoc',
                'cycleDocPath',
                'snapshotDocPath',
                'resolvedDocPaths',
                'openedDocPaths',
                'deletedOpenDocPaths',
              ],
              additionalProperties: false,
              properties: {
                runSummary: { type: 'string', minLength: 1, maxLength: 1500 },
                cycleCompleted: { type: 'integer', const: 1 },
                thesesOpened: { type: 'integer', minimum: 0 },
                thesesResolved: { type: 'integer', minimum: 0 },
                grossExposurePct: {
                  type: 'number',
                  minimum: 0,
                  description:
                    'Campaign-attributed gross exposure at cycle start: the broker gross minus the orphan positions being flattened this cycle (their absolute notionals), ÷ equity × 100 — the cross-check on the previous cycle’s self-reported projection, scored against the campaign cap. An orphan is being cleared, never a cap breach.',
                },
                brokerGrossExposurePct: {
                  type: 'number',
                  minimum: 0,
                  description:
                    'Raw broker gross at cycle start (sum of ALL absolute position notionals ÷ equity × 100, orphans included) — kept alongside the thesis-attributed number as the unfiltered broker truth.',
                },
                cycleDoc: {
                  type: 'object',
                  description:
                    'The cycle document CONTENT — persisted by a dedicated operation step at cycleDocPath, never written by this task. Its write is the cycle-completion marker and happens last.',
                  required: [
                    'tradingDay',
                    'slot',
                    'coverageNote',
                    'thesesOpened',
                    'thesesResolved',
                    'submittedCount',
                    'deferredCount',
                    'failedCount',
                    'projectedGrossExposurePct',
                    'decisionRationale',
                  ],
                  additionalProperties: false,
                  properties: {
                    tradingDay: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
                    slot: { enum: ['morning', 'after_close'] },
                    coverageNote: { type: 'string', minLength: 1, maxLength: 1000 },
                    thesesOpened: { type: 'array', items: { type: 'string' } },
                    thesesResolved: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['thesisId', 'outcome'],
                        additionalProperties: true,
                        properties: {
                          thesisId: { type: 'string' },
                          outcome: {
                            enum: ['confirmed', 'falsified', 'expired', 'entry_failed'],
                          },
                        },
                      },
                    },
                    submittedCount: { type: 'integer', minimum: 0 },
                    deferredCount: { type: 'integer', minimum: 0 },
                    failedCount: { type: 'integer', minimum: 0 },
                    projectedGrossExposurePct: { type: 'number', minimum: 0 },
                    decisionRationale: { type: 'string', minLength: 1 },
                  },
                },
                snapshotDoc: {
                  type: 'object',
                  description:
                    'The snapshot CONTENT — persisted by a dedicated operation step at snapshotDocPath, never written by this task.',
                  required: [
                    'equity',
                    'cash',
                    'positions',
                    'brokerGrossExposurePct',
                    'grossExposurePct',
                    'orphanFlattens',
                  ],
                  additionalProperties: true,
                  properties: {
                    equity: { type: 'number' },
                    cash: { type: 'number' },
                    positions: { type: 'array' },
                    brokerGrossExposurePct: { type: 'number' },
                    grossExposurePct: { type: 'number' },
                    orphanFlattens: { type: 'array' },
                  },
                },
                cycleDocPath: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 120,
                  pattern:
                    '^/portfolio/theses/cycles/[0-9]{4}-[0-9]{2}-[0-9]{2}-(morning|after_close)\\.json$',
                  description:
                    'The ledger-contract cycle-doc path for this (tradingDay, slot) — the shape is validated, a drifted path cannot pass.',
                },
                snapshotDocPath: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 120,
                  pattern:
                    '^/portfolio/snapshots/[0-9]{4}-[0-9]{2}-[0-9]{2}-(morning|after_close)\\.json$',
                },
                resolvedDocPaths: {
                  type: 'array',
                  description:
                    'Echo of every resolved-thesis doc this task wrote — the write receipt validation checks against the ledger contract.',
                  items: {
                    type: 'string',
                    pattern: '^/portfolio/theses/resolved/[a-z0-9-]+\\.json$',
                  },
                },
                openedDocPaths: {
                  type: 'array',
                  description: 'Echo of every open-thesis doc this task wrote.',
                  items: { type: 'string', pattern: '^/portfolio/theses/open/[a-z0-9-]+\\.json$' },
                },
                deletedOpenDocPaths: {
                  type: 'array',
                  description: 'Echo of every open-thesis doc this task deleted after resolution.',
                  items: { type: 'string', pattern: '^/portfolio/theses/open/[a-z0-9-]+\\.json$' },
                },
              },
            },
            derivedFrom: [
              {
                bindingId: 'learnings-per-resolution-cap',
                from: 'resolve-theses',
                binding: 'count:$.resolutions',
                target: '$.learnings.maxItems',
              },
              {
                bindingId: 'cycle-doc-trading-day-pin',
                from: 'resolve-theses',
                binding: 'value:$.tradingDay',
                target: '$.cycleDoc.tradingDay.const',
              },
              {
                bindingId: 'cycle-doc-slot-pin',
                from: 'resolve-theses',
                binding: 'value:$.slot',
                target: '$.cycleDoc.slot.const',
              },
              {
                bindingId: 'cycle-doc-submitted-pin',
                from: 'execute-orders',
                binding: 'value:$.submittedCount',
                target: '$.cycleDoc.submittedCount.const',
              },
              {
                bindingId: 'cycle-doc-deferred-pin',
                from: 'execute-orders',
                binding: 'value:$.deferredCount',
                target: '$.cycleDoc.deferredCount.const',
              },
              {
                bindingId: 'cycle-doc-failed-pin',
                from: 'execute-orders',
                binding: 'value:$.failedCount',
                target: '$.cycleDoc.failedCount.const',
              },
              {
                bindingId: 'snapshot-equity-pin',
                from: 'ingest-account',
                binding: 'value:$.equity',
                target: '$.snapshotDoc.equity.const',
              },
              {
                bindingId: 'snapshot-cash-pin',
                from: 'ingest-account',
                binding: 'value:$.cash',
                target: '$.snapshotDoc.cash.const',
              },
              {
                bindingId: 'resolved-receipt-floor',
                from: 'resolve-theses',
                binding: 'count:$.resolutions',
                target: '$.resolvedDocPaths.minItems',
              },
              {
                bindingId: 'opened-receipt-floor',
                from: 'decide',
                binding: 'count:$.theses',
                target: '$.openedDocPaths.minItems',
              },
            ],
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'cycleCompleted', toState: 'cycleCompleted' },
            { kind: 'output_path' as const, path: 'thesesOpened', toState: 'thesesOpened' },
            { kind: 'output_path' as const, path: 'thesesResolved', toState: 'thesesResolved' },
            { kind: 'output_path' as const, path: 'runSummary', toState: 'runSummary' },
          ],
        },

        {
          taskId: 'write-snapshot',
          name: 'Write snapshot',
          goal: 'Persist the validated snapshot at its contract path.',
          type: 'operation' as const,
          operation: 'memory.store.put',
          dependsOn: ['record'],
          when: CYCLE_PROCEED_GATE,
          retryability: 'safe' as const,
          inputBindings: {
            snapshotDoc: { kind: 'task_output' as const, taskId: 'record', path: 'snapshotDoc' },
            snapshotDocPath: {
              kind: 'task_output' as const,
              taskId: 'record',
              path: 'snapshotDocPath',
            },
          },
          inputTemplate: {
            path: { $bind: 'snapshotDocPath' },
            docType: 'json',
            mimeType: 'application/json',
            content: { inlineJson: { $bind: 'snapshotDoc' } },
            writeMode: 'upsert',
            indexing: 'disabled',
          },
        },

        {
          taskId: 'write-cycle-doc',
          name: 'Write cycle doc',
          goal: 'Persist the validated cycle doc at its contract path — its existence marks the cycle complete, so it is written last, after every other persistence step.',
          type: 'operation' as const,
          operation: 'memory.store.put',
          dependsOn: ['write-snapshot', 'record-learnings'],
          when: CYCLE_PROCEED_GATE,
          retryability: 'safe' as const,
          inputBindings: {
            cycleDoc: { kind: 'task_output' as const, taskId: 'record', path: 'cycleDoc' },
            cycleDocPath: { kind: 'task_output' as const, taskId: 'record', path: 'cycleDocPath' },
          },
          inputTemplate: {
            path: { $bind: 'cycleDocPath' },
            docType: 'json',
            mimeType: 'application/json',
            content: { inlineJson: { $bind: 'cycleDoc' } },
            writeMode: 'upsert',
            indexing: 'disabled',
          },
        },

        {
          taskId: 'record-learnings',
          name: 'Record learnings',
          goal: 'Persist the resolution-cited learnings to the workflow ledger. The next cycle reads them automatically.',
          type: 'operation' as const,
          operation: 'workflow.learn',
          dependsOn: ['record'],
          when: CYCLE_PROCEED_GATE,
          inputBindings: {
            learnings: { kind: 'task_output' as const, taskId: 'record', path: 'learnings' },
          },
        },
      ],
      stateVariables: [
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
            'Which scheduled slot of the trading day this cycle covered (morning / after_close).',
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
          description: 'Theses resolved (confirmed / falsified / expired) this cycle.',
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
      ],
      output: {
        primary: 'runSummary',
        guidance:
          'A completed cycle reports resolutions, new theses, and order outcomes. A run with no cycleCompleted was a duplicate-trigger or non-trading-day no-op — normal under the self-healing cadence, not a failure. Layer-2 outcome metrics (benchmark-relative return, Sharpe, drawdown) are read ONLY at the weekly checkpoint and campaign end from the ledger snapshots — never treat a single cycle’s P&L as a signal.',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'daily-trading-cycle',
      name: 'Daily Trading Cycle',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'cycle-reliability',
            description:
              'Every trading day in the campaign window completes one decision cycle per scheduled slot; a missed slot is recorded in the next cycle doc, never papered over.',
          },
          {
            id: 'thesis-discipline',
            description:
              'Every entry order derives from a validated thesis (instrument, direction, rationale, falsification, confirmation, deadline, size) written before the order.',
          },
          {
            id: 'resolution-rate',
            description:
              'Every open thesis resolves confirmed, falsified, expired, or entry_failed by its deadline; an unresolved-past-deadline thesis is a process defect. Fill truth first: only a filled entry may resolve on its price criteria.',
          },
          {
            id: 'calibration',
            description:
              'Stated thesis confidence tracks resolution outcomes of FILLED trades over the campaign window, by thesis category; an entry_failed resolution carries no market evidence and is excluded.',
          },
          {
            id: 'loop-health',
            description:
              'Each resolution produces at most one learning citing it; learnings are injected into the next cycle; no learning exists without a cited resolution.',
          },
        ],
      },
      mode: 'process' as const,
      // Cycle idempotency is a read-then-act ledger check; a single-run pin
      // keeps two triggers for the same (tradingDay, slot) from racing it.
      concurrency: {
        maxParallelTasksPerRun: 4,
        maxConcurrentRuns: 1,
        failureMode: 'isolate' as const,
        perUserSerial: false,
      },
      // regimeName is the campaign identity — a different regime is a different
      // campaign. Every field is frozen mid-campaign: pre-registration is what
      // makes the windowed evaluation honest; strategy evolves at campaign
      // boundaries only.
      campaign: {
        fields: {
          regimeName: {
            schema: {
              type: 'string',
              minLength: 3,
              maxLength: 64,
              pattern: '^[a-z0-9][a-z0-9-]*$',
            },
            identity: true,
            label: 'Regime name',
            description:
              'Short slug naming this strategy regime (e.g. "momentum-breakouts-1"). Identifies the campaign.',
          },
          hypothesis: {
            schema: { type: 'string', minLength: 20, maxLength: 1000 },
            mutable: false,
            label: 'Regime hypothesis',
            description:
              'The falsifiable strategy hypothesis this campaign tests (e.g. "momentum breakouts on liquid large-caps resolve within 1-5 days in a rising index regime"). Every thesis must be an instance of it. Frozen for the campaign window.',
          },
          universe: {
            schema: {
              type: 'array',
              items: { type: 'string', pattern: '^[A-Z][A-Z.]{0,9}$' },
              minItems: 1,
              maxItems: 30,
            },
            mutable: false,
            label: 'Universe',
            description:
              'Tickers theses may trade. The decide contract rejects any instrument outside this list.',
          },
          maxThesesPerDay: {
            schema: { type: 'integer', minimum: 0, maximum: 10 },
            mutable: false,
            label: 'Theses per cycle cap',
            description:
              'Maximum new theses per decision cycle. The aggressiveness knob: more theses = more resolutions = faster loop cycles.',
          },
          maxPositionSizePct: {
            schema: { type: 'number', exclusiveMinimum: 0, maximum: 100 },
            mutable: false,
            label: 'Per-position size cap (%)',
            description: 'Maximum entry size as a percent of account equity, per thesis.',
          },
          maxGrossExposurePct: {
            schema: { type: 'number', exclusiveMinimum: 0, maximum: 200 },
            mutable: false,
            label: 'Gross exposure cap (%)',
            description:
              'Maximum gross exposure (sum of absolute position notionals ÷ equity × 100) after each cycle.',
          },
          minHorizonTradingDays: {
            schema: { type: 'integer', minimum: 1, maximum: 5 },
            mutable: false,
            label: 'Minimum thesis horizon (trading days)',
            description: 'Shortest allowed thesis deadline. Must not exceed the maximum horizon.',
          },
          maxHorizonTradingDays: {
            schema: { type: 'integer', minimum: 1, maximum: 5 },
            mutable: false,
            label: 'Maximum thesis horizon (trading days)',
            description: 'Longest allowed thesis deadline.',
          },
          windowTradingDays: {
            schema: { type: 'integer', minimum: 5, maximum: 60 },
            mutable: false,
            label: 'Evaluation window (trading days)',
            description:
              'The pre-registered window this regime is evaluated over. Layer-2 outcome metrics (benchmark-relative return, Sharpe, drawdown) are read only at the weekly checkpoint and at the window boundary — never daily.',
          },
        },
      },
    },
    evalSuite: {
      goalCriteria: [],
      taskCriteria: {
        'resolve-theses': [
          {
            name: 'coverage-note-present',
            type: 'contains' as const,
            inField: 'coverageNote',
            pattern: '\\S',
          },
        ],
        record: [
          {
            name: 'cycle-recorded',
            type: 'threshold' as const,
            metric: 'cycleCompleted',
            operator: 'gte' as const,
            target: 1,
          },
          {
            name: 'gross-exposure-within-cap',
            type: 'threshold' as const,
            metric: 'grossExposurePct',
            operator: 'lte' as const,
            target: { $campaign: 'maxGrossExposurePct' },
          },
        ],
      },
      trajectoryCriteria: [],
      weights: { goal: 0, task: 1.0, trajectory: 0 },
      createdAt: CATALOG_EPOCH,
      updatedAt: CATALOG_EPOCH,
      createdBy: 'platform',
    },
    activation: {
      triggerPatterns: [
        'daily trading cycle',
        'trading cycle',
        'paper trading',
        'thesis trading',
        'run the trading cycle',
        'resolve theses',
      ],
      activationHint:
        'One run = one trading-cycle slot on the Alpaca paper account. Requires an active campaign (regime name, hypothesis, universe, caps, horizon bounds, window). Runs normally fire from the post-open and after-close schedules and self-heal missed slots — a manual run is the fallback of last resort and is idempotent per (tradingDay, slot). Orders submit only while the market is open; closed-market cycles defer them as intentions.',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'The thesis — not the trade — is the unit of decision, measurement, and learning: every order derives from a validated thesis with written falsification/confirmation criteria and a deadline, so each resolution is a clean truth event independent of portfolio noise. The strategy regime lives entirely in the campaign contract (structured caps + one prose hypothesis, frozen mid-window); the skill is strategy-agnostic machinery. Campaign caps are bound into the decide contract at delegation time (structural risk-gate, no human gate on paper), order authority is isolated to one task, and cycles are idempotent per (tradingDay, slot) via the ledger so the semi-daily cadence self-heals missed slots.',
  },
};

export { DAILY_TRADING_CYCLE };
