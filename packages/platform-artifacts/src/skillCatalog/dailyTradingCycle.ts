import type { SkillCatalogEntry } from '@aflow/schemas';
import { CATALOG_EPOCH } from './constants.js';
import {
  DAILY_CYCLE_RESOLVE_THESES_PROMPT,
  DAILY_CYCLE_DECIDE_PROMPT,
  DAILY_CYCLE_EXECUTE_ORDERS_PROMPT,
  DAILY_CYCLE_RECORD_PROMPT,
} from './dailyTradingCycleProse.js';
import {
  APPROVED_SET_SOUND_CRITERION,
  APPROVED_THESES_PATH_TEMPLATE,
  APPROVED_THESES_VALIDATOR_REF,
  DECIDE_IDENTITY_PINS,
  DECIDE_IDENTITY_PROPERTIES,
  DECIDE_SET_FAULT_PROPERTY,
  OPENED_APPROVALS_PINS,
  ORDER_APPROVAL_PROPERTY,
  ORDER_APPROVAL_RULES,
  RECORD_SET_FAULT_METRIC,
  RECORD_SET_FAULT_RULES,
  THESIS_APPROVAL_PROPERTIES,
} from './dailyTradingCycleApproved.js';
import { CYCLE_SET_TASKS, TALLY_SET_TASK_ID } from './dailyTradingCycleSet.js';
import {
  ARM_TABLE_SCHEMA,
  DAILY_TRADING_CYCLE_CAMPAIGN,
  RECORD_ARM_BINDINGS,
  RECORD_ARM_TABLE_RULES,
} from './dailyTradingCycleCampaign.js';
import {
  CYCLE_DOC_PATH_PATTERN,
  CYCLE_RUN_INPUTS,
  INTRADAY_INDEX_RULE,
  RESOLUTION_OUTCOMES,
  RESOLVE_SLOT_RULES,
  SLOT_INDEX_INPUT_SCHEMA,
  SLOT_INDEX_SCHEMA,
  SLOT_SCHEMA,
  SNAPSHOT_DOC_PATH_PATTERN,
} from './dailyTradingCycleSlots.js';
import {
  CYCLE_PROCEED_GATE,
  DECISION_STATE_BINDINGS,
  DECISION_STATE_TASK,
  REGIME_CONTEXT_TASKS,
  writeCycleDocTask,
  writeSnapshotTask,
} from './dailyTradingCycleGather.js';
import { DECIDE_REGIME_PIN, DECIDE_REGIME_PROPERTIES } from './dailyTradingCycleRegime.js';
import { CYCLE_DOC_SCHEMA, SNAPSHOT_DOC_SCHEMA } from './dailyTradingCycleDocs.js';
import { EXCHANGE_CLOCK_READ } from './exchangeClock.js';
import {
  FRACTIONAL_TRADING_BINDING,
  FRACTIONAL_TRADING_PIN,
  FRACTIONAL_TRADING_PROPERTY,
  ORDER_SIZING_PROPERTIES,
  ORDER_SIZING_RULES,
} from './dailyTradingCycleShortSizing.js';
import { CLOSE_REPORT_PATH_TEMPLATE, CLOSE_REPORT_TASKS } from './dailyTradingCycleCloseReport.js';
import { CYCLE_STATE_VARIABLES } from './dailyTradingCycleState.js';
import * as MEASURES from './dailyTradingCycleMeasures.js';

const DAILY_TRADING_CYCLE: SkillCatalogEntry = {
  catalogId: 'daily-trading-cycle',
  version: 15,
  name: 'Daily Trading Cycle',
  tagline:
    'Thesis-driven paper-trading cycle: resolve open theses, decide new ones, execute, record.',
  description: `One run = one trading-cycle slot on an Alpaca paper account. The campaign defines what a trade is: its named hypotheses, one arm each, its universe and its horizon bounds. The Strategy Desk writes the day's approved set of reviewed candidates. The agent decides which approved candidates to trade, when and how much, and executes. The unit of decision, measurement and learning is the **thesis**: hypothesis arm, instrument, direction, rationale, falsification criterion, confirmation criterion, deadline and size, written before its order.

**Every slot may act**: \`pre_market\`, \`open\`, \`intraday\` and \`after_close\` each resolve, decide, execute and record. An order the market cannot take now waits as an intention, and the next open-market cycle submits it. pre_market sees no price of the session, so it resolves on order facts only. after_close resolves on the close and writes the close report.

**The day's set, in the same firing**: a cycle reads the day's set at \`${APPROVED_THESES_PATH_TEMPLATE}\`. Where the day has none and the schedule passes \`bindingId\`, the cycle runs the Strategy Desk first and waits for it. A code tally of the set gives decide the approved candidates. decide's contract refuses a thesis that names no approved candidate, one the review turned down, and one already opened today. Nothing else is gated: the agent sizes from the strategist's size and the account, and execution checks only what the account can express.

**Market regime, as information**: each cycle computes the regime by rule from the market-data reads: SPY, QQQ and IWM against their 20-day and 50-day averages, SPY's realized volatility, and the breadth of the universe members with enough sessions. decide reads it. A regime that cannot be gathered is named unavailable and stops nothing.

**Self-healing cadence**: the schedule names the slot in the run input (\`slot\`, plus \`slotIndex\` for intraday firings). Absent, the slot derives from the exchange clock. Runs are idempotent per (tradingDay, slot) via the ledger's cycle docs, and resolution processes everything pending since the last completed cycle.

**Close report**: the after_close cycle writes the close report at \`${CLOSE_REPORT_PATH_TEMPLATE}\` from the day's cycle docs, a record only. The Strategy Desk reads the Trading Reflection journal, never the close report.

**Two-layer measurement**: Layer-1 process metrics derive from the ledger. Layer-2 outcome metrics (benchmark-relative return, Sharpe, drawdown) are read at pre-registered boundaries. Raw daily P&L is not a signal.

**Prerequisites**: Alpaca paper API credentials, an active campaign, and the cycle schedules, each naming its slot and the desk's \`bindingId\`.`,
  tags: ['alpaca', 'trading', 'paper', 'theses', 'campaigns'],
  bundle: {
    workflow: {
      slug: 'daily-trading-cycle',
      name: 'Daily Trading Cycle',
      description:
        'One thesis-driven trading cycle on the Alpaca paper account: ingest state, resolve open theses, gather the market regime, read the day’s approved set (running the desk first where the day has none), decide and execute new theses, record the cycle to the ledger.',
      goal: 'Run one complete, honestly-recorded decision cycle per (tradingDay, slot): every open thesis evaluated against its written criteria, every new thesis an approved candidate fully specified before its order, every outcome appended to the thesis ledger with learnings extracted only from resolutions.',
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
      runInputs: CYCLE_RUN_INPUTS,
      tasks: [
        {
          taskId: 'ingest-clock',
          name: 'Ingest market clock',
          goal: 'Read the exchange clock — the timestamp anchors the trading day, the open/close boundaries decide the slot when the run input names none.',
          type: 'operation' as const,
          operation: EXCHANGE_CLOCK_READ.operation,
          retryability: 'safe' as const,
          // The entry task's contract is the skill's input surface: a run input missing
          // from it is refused at start. resolve-theses reads the slot, and set-state the folder.
          inputContract: {
            bindings: {
              slot: {
                kind: 'run_input' as const,
                bindAs: 'slot',
                path: 'slot',
                schema: SLOT_SCHEMA,
              },
              slotIndex: {
                kind: 'run_input' as const,
                bindAs: 'slotIndex',
                path: 'slotIndex',
                schema: SLOT_INDEX_INPUT_SCHEMA,
              },
              bindingId: {
                kind: 'run_input' as const,
                bindAs: 'bindingId',
                path: 'bindingId',
                schema: { type: 'string', minLength: 1, maxLength: 128 },
              },
            },
          },
          inputTemplate: EXCHANGE_CLOCK_READ.inputTemplate,
          outputProjection: EXCHANGE_CLOCK_READ.outputProjection,
          outputContract: EXCHANGE_CLOCK_READ.outputContract,
        },

        {
          taskId: 'ingest-account',
          name: 'Ingest account state',
          goal: 'Read account equity, cash, buying power and whether the account trades fractional shares — the sizing base for every entry this cycle.',
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
            // An account read that omits the attribute reads null: the capability is unknown.
            fractionalTrading: { path: 'data.fractional_trading', onMissing: 'null' as const },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['equity', 'cash', 'buyingPower', 'accountStatus', 'fractionalTrading'],
              additionalProperties: false,
              properties: {
                equity: { type: 'number' },
                cash: { type: 'number' },
                buyingPower: { type: 'number' },
                accountStatus: { type: 'string' },
                fractionalTrading: { type: ['boolean', 'null'] },
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
            requestedSlot: { kind: 'run_input' as const, path: 'slot' },
            requestedSlotIndex: { kind: 'run_input' as const, path: 'slotIndex' },
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
                'slotIndex',
                'proceed',
                'noopReason',
                'resolutions',
                'openThesesAfter',
                'pendingIntentions',
                'repairCloses',
                'orphanFlattens',
                'thesesOpenedToday',
                'approvedOpenedToday',
                'coverageNote',
                'benchmarkClose',
              ],
              additionalProperties: false,
              allOf: RESOLVE_SLOT_RULES,
              properties: {
                ...MEASURES.RESOLVE_BENCHMARK_PROPERTY,
                tradingDay: {
                  type: 'string',
                  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
                  description: 'The trading day this cycle belongs to, derived from the clock.',
                },
                slot: {
                  ...SLOT_SCHEMA,
                  description:
                    'The slot `requestedSlot` names, when given. Otherwise derived from the clock.',
                },
                slotIndex: {
                  ...SLOT_INDEX_SCHEMA,
                  description: `The intraday firing number: \`requestedSlotIndex\` when given, otherwise ${INTRADAY_INDEX_RULE}. An integer on an intraday slot, null on every other slot.`,
                },
                thesesOpenedToday: {
                  type: 'array',
                  uniqueItems: true,
                  items: { type: 'string' },
                  description:
                    'Every thesisId the cycle docs of this trading day list as opened, in any earlier slot.',
                },
                approvedOpenedToday: {
                  type: 'array',
                  uniqueItems: true,
                  items: { type: 'string' },
                  description:
                    'Every approvedId the openedApprovals of this trading day’s cycle docs name, in any earlier slot. decide opens each approved candidate once.',
                },
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
                      'entryFillPrice',
                    ],
                    additionalProperties: false,
                    properties: {
                      thesisId: { type: 'string' },
                      instrument: { type: 'string' },
                      direction: { enum: ['long', 'short'] },
                      outcome: {
                        enum: [...RESOLUTION_OUTCOMES],
                        description:
                          'Fill truth first: only a thesis whose entry order FILLED may resolve confirmed / falsified / expired / tactical_exit. An entry that is unfilled, expired, cancelled, or rejected — or a deferred entry intention past the thesis deadline — resolves entry_failed: no position ever existed. tactical_exit closes a live thesis on an open or intraday slot before either criterion triggers, on a current-price reason stated in evidence. A pre_market cycle sees no price of the coming session and resolves entry_failed only.',
                      },
                      entryFillState: {
                        enum: ['filled', 'partial', 'none'],
                        description:
                          'The entry’s fill truth as read from the broker. confirmed / falsified / expired / tactical_exit are valid only with filled or partial. entry_failed is valid only with none — the explicit assertion evals cross-check against broker data.',
                      },
                      evidence: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 1500,
                        description:
                          'Observed prices quoted against the written criterion — a resolution rests on data, never on a guess. For entry_failed: the order-state facts (status, expiry, rejection); the prediction outcome may be noted, but with no P&L attribution and no position narration.',
                      },
                      statedConfidence: { enum: ['low', 'medium', 'high'] },
                      ...MEASURES.RESOLUTION_ENTRY_FILL_PROPERTY,
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

        ...REGIME_CONTEXT_TASKS,

        ...CYCLE_SET_TASKS,

        {
          taskId: 'decide',
          name: 'Decide new theses',
          goal: DAILY_CYCLE_DECIDE_PROMPT,
          type: 'agent' as const,
          dependsOn: ['regime-state', 'read-pre-market', TALLY_SET_TASK_ID],
          when: CYCLE_PROCEED_GATE,
          // A decision that cannot be made or checked must not stop the closes,
          // the record or the completion.
          optional: true,
          inputBindings: {
            tradingDay: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'tradingDay',
            },
            slot: { kind: 'task_output' as const, taskId: 'resolve-theses', path: 'slot' },
            marketIsOpen: { kind: 'task_output' as const, taskId: 'ingest-clock', path: 'isOpen' },
            approvedOpenedToday: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'approvedOpenedToday',
            },
            // Absent where the tally failed: decide then opens nothing.
            approvedCandidates: {
              kind: 'task_output' as const,
              taskId: TALLY_SET_TASK_ID,
              path: 'approved',
            },
            turnedDown: {
              kind: 'task_output' as const,
              taskId: TALLY_SET_TASK_ID,
              path: 'turnedDown',
            },
            setNote: { kind: 'task_output' as const, taskId: TALLY_SET_TASK_ID, path: 'setNote' },
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
            ...FRACTIONAL_TRADING_BINDING,
            positions: {
              kind: 'task_output' as const,
              taskId: 'ingest-positions',
              path: 'positions',
            },
            regimeName: { kind: 'campaign_input' as const, path: 'regimeName' },
            hypotheses: { kind: 'campaign_input' as const, path: 'hypotheses' },
            minHorizonTradingDays: {
              kind: 'campaign_input' as const,
              path: 'minHorizonTradingDays',
            },
            maxHorizonTradingDays: {
              kind: 'campaign_input' as const,
              path: 'maxHorizonTradingDays',
            },
            marketState: { kind: 'task_output' as const, taskId: 'regime-state', path: 'decision' },
            // Absent where the regime could not be gathered: marketState is then unavailable.
            marketRegime: {
              kind: 'task_output' as const,
              taskId: 'gather-regime',
              path: 'marketRegime',
            },
            // Absent where the space binds no calendar source.
            calendar: { kind: 'task_output' as const, taskId: 'ingest-calendar', path: 'calendar' },
            // Absent where the pre-market read failed. The cycle doc names the fault.
            preMarketEvidence: { kind: 'task_output' as const, taskId: 'read-pre-market' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'active' as const,
            capabilities: {
              // No memory write: decide writes nothing it needs. Its theses
              // and rationale are its output, and resolve-theses keeps the
              // market-data cache.
              operations: ['memory.store.get', 'memory.store.query'],
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
          // The approved set is a document, so a validatorRef reads it at
          // submission. It catches a thesis the review did not approve, and
          // nothing else: size, timing and levels are the decision's.
          outputContract: {
            schema: {
              type: 'object',
              required: [
                'tradingDay',
                'regimeName',
                'marketState',
                'bias',
                'approvedSetFault',
                'theses',
                'projectedGrossExposurePct',
                'decisionRationale',
              ],
              additionalProperties: false,
              properties: {
                ...DECIDE_IDENTITY_PROPERTIES,
                ...DECIDE_REGIME_PROPERTIES,
                regimeName: {
                  type: 'string',
                  description: 'The campaign’s regimeName, copied from your input. It is pinned.',
                },
                ...DECIDE_SET_FAULT_PROPERTY,
                theses: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: [
                      'thesisId',
                      'hypothesisId',
                      'approvedId',
                      'instrument',
                      'direction',
                      'rationale',
                      'entryCondition',
                      'falsificationCriterion',
                      'confirmationCriterion',
                      'deadlineTradingDays',
                      'sizePct',
                      'confidence',
                      'entryLevel',
                      'invalidationLevel',
                    ],
                    additionalProperties: false,
                    properties: {
                      thesisId: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{2,63}$' },
                      hypothesisId: {
                        type: 'string',
                        description: 'The campaign arm its approved candidate names.',
                      },
                      ...THESIS_APPROVAL_PROPERTIES,
                      ...MEASURES.THESIS_LEVEL_PROPERTIES,
                      instrument: { type: 'string' },
                      direction: { enum: ['long', 'short'] },
                      rationale: { type: 'string', minLength: 1, maxLength: 8000 },
                      entryCondition: {
                        type: ['string', 'null'],
                        minLength: 1,
                        maxLength: 2000,
                        description:
                          'A price condition that makes the entry due (e.g. "trades above 187.40"), or null to enter at the next open-market submission. The executing cycle reads it against a fresh snapshot.',
                      },
                      falsificationCriterion: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 2000,
                        description:
                          'Price-checkable condition that proves the thesis wrong — a later cycle must be able to read prices and answer yes/no.',
                      },
                      confirmationCriterion: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 2000,
                        description: 'Price-checkable condition that proves the thesis right.',
                      },
                      deadlineTradingDays: { type: 'integer', minimum: 1 },
                      sizePct: {
                        type: 'number',
                        exclusiveMinimum: 0,
                        description:
                          'Percent of equity for the entry: the strategist’s size unless you have a reason to change it. Execution sizes the order from it and the account it reads then.',
                      },
                      confidence: { enum: ['low', 'medium', 'high'] },
                    },
                  },
                },
                projectedGrossExposurePct: {
                  type: 'number',
                  minimum: 0,
                  description:
                    'Thesis-attributed gross exposure (÷ equity × 100) after this cycle’s closes, the pending deferred intentions and the proposed entries, orphan flattens excluded. A record of the exposure you decided into.',
                },
                decisionRationale: { type: 'string', minLength: 1, maxLength: 8000 },
              },
            },
            derivedFrom: [
              {
                bindingId: 'decide-regime-pin',
                from: '$campaign',
                binding: 'value:$.regimeName',
                target: '$.regimeName.const',
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
              ...DECIDE_IDENTITY_PINS,
              DECIDE_REGIME_PIN,
            ],
            validatorRefs: [APPROVED_THESES_VALIDATOR_REF],
          },
        },

        DECISION_STATE_TASK,

        {
          taskId: 'execute-orders',
          name: 'Execute orders',
          goal: DAILY_CYCLE_EXECUTE_ORDERS_PROMPT,
          type: 'agent' as const,
          dependsOn: [DECISION_STATE_TASK.taskId],
          when: CYCLE_PROCEED_GATE,
          inputBindings: {
            tradingDay: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'tradingDay',
            },
            slot: { kind: 'task_output' as const, taskId: 'resolve-theses', path: 'slot' },
            slotIndex: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'slotIndex',
            },
            marketIsOpen: { kind: 'task_output' as const, taskId: 'ingest-clock', path: 'isOpen' },
            resolutions: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'resolutions',
            },
            // Absent where decide produced no decision: no new entry opens.
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
            buyingPower: {
              kind: 'task_output' as const,
              taskId: 'ingest-account',
              path: 'buyingPower',
            },
            ...FRACTIONAL_TRADING_BINDING,
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
              // same-cycle fill verification; the snapshot read prices short
              // sizing at submission time.
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
              required: [
                'slot',
                'fractionalTrading',
                'orderResults',
                'submittedCount',
                'deferredCount',
                'failedCount',
              ],
              additionalProperties: false,
              allOf: [...ORDER_APPROVAL_RULES, ...ORDER_SIZING_RULES],
              properties: {
                slot: {
                  ...SLOT_SCHEMA,
                  description: 'This cycle’s slot, copied from your input. It is pinned.',
                },
                ...FRACTIONAL_TRADING_PROPERTY,
                orderResults: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: [
                      'clientOrderId',
                      'thesisId',
                      'approvedId',
                      'intent',
                      'symbol',
                      'side',
                      'qty',
                      'notional',
                      'entryCondition',
                      'disposition',
                      'statusCode',
                      'orderId',
                      'orderStatus',
                      'fillState',
                      'filledAvgPrice',
                      'shortSizing',
                      'failureSource',
                      'error',
                    ],
                    additionalProperties: false,
                    properties: {
                      clientOrderId: { type: 'string' },
                      thesisId: { type: 'string' },
                      ...ORDER_APPROVAL_PROPERTY,
                      intent: { enum: ['open', 'close'] },
                      symbol: { type: 'string' },
                      side: { enum: ['buy', 'sell'] },
                      qty: {
                        type: ['string', 'null'],
                        description:
                          'Order quantity. A close submits the held quantity verbatim — fractional allowed, a long opened by notional holds fractional shares. A short entry sizes whole shares (floor of notional / price). Only where that floor is 0 and fractionalTrading is true does it send a fractional qty under one share (notional / price, to 9 decimal places). Fractional short sales are unverified on this broker, so a fractional qty is a last resort. shortSizing names the rule used.',
                      },
                      notional: {
                        type: ['string', 'null'],
                        description:
                          'Dollar sizing — long entries; for a short entry, the target its qty was derived from, in whole or fractional shares as shortSizing says.',
                      },
                      entryCondition: {
                        type: ['string', 'null'],
                        description:
                          'The entry condition of the thesis behind an entry, copied verbatim and stored on its intention doc. null for a close and for an entry with none.',
                      },
                      disposition: {
                        enum: ['submitted', 'duplicate', 'deferred', 'expired', 'failed'],
                        description:
                          'submitted = the broker acknowledged the order (2xx + order id). duplicate = the client order id already exists at the broker — found in the pre-submission orders list, or rejected as already used on submit; either way the prior submission stands, counted in neither submittedCount nor failedCount. deferred = recorded as an intention: the market is closed, the slot is pre_market, or the entry condition is not met yet. expired = a pending entry intention dropped unsubmitted (thesis deadline passed, or no open-thesis doc behind it). failed = the order did not land, and failureSource says why: the broker rejected it (any other non-2xx), the sizing rule gave a qty the broker cannot take (no broker call), or it was not submitted for another reason (no broker call).',
                      },
                      statusCode: {
                        type: ['integer', 'null'],
                        description:
                          'HTTP status of the broker call; null when no call was made (deferred / expired / a failed order whose failureSource is sizing_rule or not_submitted / a duplicate settled from the pre-submission orders list). The gate for disposition: only 2xx with an order id is submitted; a duplicate-id rejection is duplicate; anything else outside 2xx is failed — a plausible body never overrides the status.',
                      },
                      orderId: { type: ['string', 'null'] },
                      orderStatus: { type: ['string', 'null'] },
                      fillState: {
                        enum: ['filled', 'partial', 'pending', null],
                        description:
                          'Same-cycle fill verification, polled per submitted order; null when not submitted this run (deferred / expired / failed / duplicate — a duplicate’s fill truth is read by next cycle’s resolution).',
                      },
                      ...MEASURES.ORDER_FILL_PRICE_PROPERTY,
                      ...ORDER_SIZING_PROPERTIES,
                      error: {
                        type: ['string', 'null'],
                        description:
                          'Why the order did not land, or the trim note on a close. A broker rejection carries the broker’s message verbatim. An order the sizing rule sized to zero names the rule, the price and the target, and says no order was sent. An order the broker never received is never called a broker rejection.',
                      },
                    },
                  },
                },
                submittedCount: { type: 'integer', minimum: 0 },
                deferredCount: { type: 'integer', minimum: 0 },
                failedCount: { type: 'integer', minimum: 0 },
              },
            },
            derivedFrom: [
              {
                bindingId: 'execute-slot-pin',
                from: 'resolve-theses',
                binding: 'value:$.slot',
                target: '$.slot.const',
              },
              FRACTIONAL_TRADING_PIN,
            ],
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
            slotIndex: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'slotIndex',
            },
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
            // decide's fields are absent where it produced no decision.
            theses: { kind: 'task_output' as const, taskId: 'decide', path: 'theses' },
            decisionRationale: {
              kind: 'task_output' as const,
              taskId: 'decide',
              path: 'decisionRationale',
            },
            ...DECISION_STATE_BINDINGS,
            approvedSetFault: {
              kind: 'task_output' as const,
              taskId: 'decide',
              path: 'approvedSetFault',
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
            ...MEASURES.RECORD_BENCHMARK_BINDING,
            regimeName: { kind: 'campaign_input' as const, path: 'regimeName' },
            hypotheses: { kind: 'campaign_input' as const, path: 'hypotheses' },
            // Absent where the regime could not be gathered.
            marketRegime: {
              kind: 'task_output' as const,
              taskId: 'gather-regime',
              path: 'marketRegime',
            },
            bias: { kind: 'task_output' as const, taskId: 'decide', path: 'bias' },
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
                'armTable',
                'approvedSetFaults',
              ],
              additionalProperties: false,
              allOf: [...RECORD_ARM_TABLE_RULES, ...RECORD_SET_FAULT_RULES],
              properties: {
                runSummary: { type: 'string', minLength: 1, maxLength: 8000 },
                armTable: ARM_TABLE_SCHEMA,
                cycleCompleted: { type: 'integer', const: 1 },
                ...RECORD_SET_FAULT_METRIC,
                thesesOpened: { type: 'integer', minimum: 0 },
                thesesResolved: { type: 'integer', minimum: 0 },
                grossExposurePct: {
                  type: 'number',
                  minimum: 0,
                  description:
                    'Campaign-attributed gross exposure at cycle start: the broker gross minus the orphan positions being flattened this cycle (their absolute notionals), ÷ equity × 100 — the cross-check on the previous cycle’s projection.',
                },
                brokerGrossExposurePct: {
                  type: 'number',
                  minimum: 0,
                  description:
                    'Raw broker gross at cycle start (sum of ALL absolute position notionals ÷ equity × 100, orphans included) — kept alongside the thesis-attributed number as the unfiltered broker truth.',
                },
                cycleDoc: CYCLE_DOC_SCHEMA,
                snapshotDoc: SNAPSHOT_DOC_SCHEMA,
                cycleDocPath: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 120,
                  pattern: CYCLE_DOC_PATH_PATTERN,
                  description:
                    'The ledger-contract cycle-doc path for this (tradingDay, slot) — the shape is validated, a drifted path cannot pass.',
                },
                snapshotDocPath: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 120,
                  pattern: SNAPSHOT_DOC_PATH_PATTERN,
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
                bindingId: 'cycle-doc-slot-index-pin',
                from: 'resolve-theses',
                binding: 'value:$.slotIndex',
                target: '$.cycleDoc.slotIndex.const',
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
                whenUpstreamFailed: { value: 0 },
              },
              ...RECORD_ARM_BINDINGS,
              ...OPENED_APPROVALS_PINS,
              MEASURES.SNAPSHOT_BENCHMARK_PIN,
            ],
            validatorRefs: [...MEASURES.RECORD_VALIDATOR_REFS],
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'cycleCompleted', toState: 'cycleCompleted' },
            { kind: 'output_path' as const, path: 'thesesOpened', toState: 'thesesOpened' },
            { kind: 'output_path' as const, path: 'thesesResolved', toState: 'thesesResolved' },
            { kind: 'output_path' as const, path: 'runSummary', toState: 'runSummary' },
          ],
        },

        writeSnapshotTask(SNAPSHOT_DOC_SCHEMA.required),

        writeCycleDocTask(CYCLE_DOC_SCHEMA.required),

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

        ...CLOSE_REPORT_TASKS,
      ],
      stateVariables: CYCLE_STATE_VARIABLES,
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
              'Every trading day in the campaign window completes one decision cycle per scheduled slot (pre_market, open, each intraday firing, after_close); a missed slot is recorded in the next cycle doc, never papered over.',
          },
          {
            id: 'thesis-discipline',
            description:
              'Every entry order derives from a thesis (hypothesis arm, instrument, direction, rationale, falsification, confirmation, deadline, size) written before the order. Every thesis instantiates an approved candidate of the day’s set and carries its approvedId.',
          },
          {
            id: 'resolution-rate',
            description:
              'Every open thesis resolves confirmed, falsified, expired, entry_failed, or tactical_exit by its deadline; an unresolved-past-deadline thesis is a process defect. Fill truth first: only a filled entry may resolve on its price criteria.',
          },
          {
            id: 'calibration',
            description:
              'Stated thesis confidence tracks resolution outcomes of FILLED trades over the campaign window within the campaign’s calibrationRule, per hypothesis arm. An entry_failed resolution carries no market evidence and is excluded. A tactical_exit tested neither criterion and is excluded too.',
          },
          {
            id: 'loop-health',
            description:
              'Each resolution produces at most one learning citing it; learnings are injected into the next cycle; no learning exists without a cited resolution.',
          },
          {
            id: 'lens-predictiveness',
            description:
              'Each review lens’s rejection rate is set against the falsification rate of the filled theses the tally approved over it, joined by approvedId to the day’s set. It is read over the campaign window, never per cycle.',
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
      // makes the windowed evaluation honest. Strategy evolves at campaign
      // boundaries only.
      campaign: DAILY_TRADING_CYCLE_CAMPAIGN,
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
          APPROVED_SET_SOUND_CRITERION,
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
        'One run = one trading-cycle slot on the Alpaca paper account. Requires an active campaign. Runs fire from the pre-market, open, intraday and after-close schedules, each passing inputs { slot, bindingId }, and self-heal missed slots. A run with no slot derives one from the clock. Runs are idempotent per (tradingDay, slot). Orders submit while the market is open, and wait as intentions while it is closed.',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'The thesis — not the trade — is the unit of decision, measurement, and learning: every order derives from a thesis with written falsification and confirmation criteria and a deadline, so each resolution is a clean truth event. The campaign defines what a trade is: its arms, universe and horizon. The desk reviews candidates, and the agent decides which approved ones to trade, when and how much, then executes. The contracts hold only what the strategy defines, what the broker requires and what the account can express. Order authority is isolated to one task, and cycles are idempotent per (tradingDay, slot) via the ledger so missed slots self-heal. The regime is computed by rule and read as information.',
  },
};

export { DAILY_TRADING_CYCLE };
