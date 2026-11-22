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
  CYCLE_DOC_SET_FAULT_PROPERTY,
  DECIDE_IDENTITY_PINS,
  DECIDE_IDENTITY_PROPERTIES,
  DECIDE_SET_FAULT_PROPERTY,
  OPENED_APPROVALS_PINS,
  OPENED_APPROVALS_SCHEMA,
  ORDER_APPROVAL_PROPERTY,
  ORDER_APPROVAL_RULES,
  RECORD_SET_FAULT_METRIC,
  RECORD_SET_FAULT_RULES,
  THESIS_APPROVAL_PROPERTIES,
} from './dailyTradingCycleApproved.js';
import {
  ARM_TABLE_SCHEMA,
  DAILY_TRADING_CYCLE_CAMPAIGN,
  RECORD_ARM_BINDINGS,
  RECORD_ARM_TABLE_RULES,
} from './dailyTradingCycleCampaign.js';
import {
  CYCLE_DOC_PATH_PATTERN,
  CYCLE_RUN_INPUTS,
  DECIDE_SLOT_RULES,
  EXECUTE_SLOT_RULES,
  INTRADAY_INDEX_RULE,
  RESOLUTION_OUTCOMES,
  RESOLVE_SLOT_RULES,
  SLOT_INDEX_INPUT_SCHEMA,
  SLOT_INDEX_SCHEMA,
  SLOT_SCHEMA,
  SNAPSHOT_DOC_PATH_PATTERN,
  TRADING_DAY_INPUT_SCHEMA,
} from './dailyTradingCycleSlots.js';
import {
  CYCLE_PROCEED_GATE,
  DECISION_STATE_BINDINGS,
  DECISION_STATE_TASK,
  REGIME_CONTEXT_TASKS,
  writeCycleDocTask,
  writeSnapshotTask,
} from './dailyTradingCycleGather.js';
import {
  DECIDE_REGIME_RULES,
  DECIDE_REGIME_PIN,
  DECIDE_REGIME_PROPERTIES,
  REGIME_CAPS_VALIDATOR_REF,
} from './dailyTradingCycleRegime.js';
import { CLOSE_REPORT_PATH_TEMPLATE, CLOSE_REPORT_TASKS } from './dailyTradingCycleCloseReport.js';
import { CYCLE_STATE_VARIABLES } from './dailyTradingCycleState.js';
import * as LENS_RECORD from './dailyTradingCycleLenses.js';

const CYCLE_DOC_SCHEMA = {
  type: 'object',
  description:
    'The cycle document CONTENT — persisted by a dedicated operation step at cycleDocPath, never written by this task. The step adds decide’s bias and the market regime. Its write is the cycle-completion marker and happens last.',
  required: [
    'tradingDay',
    'slot',
    'slotIndex',
    'coverageNote',
    'thesesOpened',
    'openedApprovals',
    'approvedSetFault',
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
    slot: SLOT_SCHEMA,
    slotIndex: SLOT_INDEX_SCHEMA,
    coverageNote: { type: 'string', minLength: 1, maxLength: 1000 },
    thesesOpened: { type: 'array', items: { type: 'string' } },
    ...OPENED_APPROVALS_SCHEMA,
    ...CYCLE_DOC_SET_FAULT_PROPERTY,
    thesesResolved: {
      type: 'array',
      items: {
        type: 'object',
        required: ['thesisId', 'hypothesisId', 'outcome'],
        additionalProperties: true,
        properties: {
          thesisId: { type: 'string' },
          hypothesisId: {
            type: 'string',
            minLength: 1,
            description:
              'The arm the thesis’s ledger doc names. The contract refuses any other value.',
          },
          outcome: { enum: [...RESOLUTION_OUTCOMES] },
          ...LENS_RECORD.RECORDED_LENSES_PROPERTY,
        },
      },
    },
    submittedCount: { type: 'integer', minimum: 0 },
    deferredCount: { type: 'integer', minimum: 0 },
    failedCount: { type: 'integer', minimum: 0 },
    projectedGrossExposurePct: { type: 'number', minimum: 0 },
    decisionRationale: { type: 'string', minLength: 1 },
  },
};

// The write steps persist these fields, each from this contract, with the
// market regime added from the tasks that gathered it.
const SNAPSHOT_DOC_SCHEMA = {
  type: 'object',
  description:
    'The snapshot CONTENT — persisted by a dedicated operation step at snapshotDocPath, never written by this task. The step adds the market regime.',
  required: [
    'equity',
    'cash',
    'positions',
    'brokerGrossExposurePct',
    'grossExposurePct',
    'orphanFlattens',
    'armTable',
  ],
  additionalProperties: false,
  properties: {
    equity: { type: 'number' },
    cash: { type: 'number' },
    positions: { type: 'array' },
    brokerGrossExposurePct: { type: 'number' },
    grossExposurePct: { type: 'number' },
    orphanFlattens: { type: 'array' },
    armTable: {
      ...ARM_TABLE_SCHEMA,
      description: 'The same table as armTable, or null where armTable is null.',
    },
  },
};

const DAILY_TRADING_CYCLE: SkillCatalogEntry = {
  catalogId: 'daily-trading-cycle',
  version: 10,
  name: 'Daily Trading Cycle',
  tagline:
    'Thesis-driven paper-trading cycle: resolve open theses, decide new ones, execute, record.',
  description: `One run = one trading-cycle slot on an Alpaca paper account. A trading day has four kinds of slot: \`pre_market\` forms the day's theses as deferred intentions with entry conditions, \`open\` and \`intraday\` submit due intentions and resolve open theses on current prices, and \`after_close\` resolves on the close and records. What each slot may do is part of its task contracts. The unit of decision, measurement, and learning is the **thesis** — hypothesis arm + instrument + direction + rationale + falsification criterion + confirmation criterion + deadline + size, written and validated BEFORE any order exists. Each cycle resolves every open thesis against fill truth first, then its written criteria (confirmed / falsified / expired for filled entries; entry_failed otherwise), proposes new theses under the campaign's frozen hypotheses, executes the resulting orders (submitting only while the market is open — closed-market proposals defer as intentions), and appends everything to the thesis ledger under \`/portfolio/theses/\`.

**Campaign-driven, several hypotheses per campaign**: the strategy regime lives in the campaign contract — regime name, the named hypotheses it tests side by side (each an arm with its own daily thesis budget), universe, theses/day cap, per-position and gross-exposure caps, horizon bounds, the pre-registered evaluation window, and the boundary rules: a pooled sample floor, an expectancy floor in R, and a calibration rule. Every thesis cites one arm by id, and the contract refuses an id the campaign does not declare. The after_close cycle reports a per-arm table of theses opened, open and resolved by outcome, counted from the thesis ledger. The regime is frozen mid-campaign; strategy evolves at campaign boundaries via campaign-end synthesis and vetted learnings.

**Structural risk-gate, no human gate**: the campaign caps are bound into the decide task's output contract — a thesis outside the universe, over the size cap, past the horizon bounds, or breaching gross exposure (pending deferred intentions included) is rejected by schema validation and returned to the agent as a teaching error. Paper trading carries zero financial risk; the structural gate is the safety layer.

**Market regime, per-regime caps**: each cycle gathers the market regime from the market-data binding. It covers SPY, QQQ and IWM against their 20-day and 50-day averages, SPY's realized volatility, and the share of universe members above their 20-day average. The index closes come from a read through the market-data binding, and the regime is as of the latest completed session the contract computes from the clock. The contract pins each index series to the last 50 completed sessions of that read ending on asOf, each bar held to the read's bar of its session. The contract recomputes every number from the closes the cycle reports, and the numbers give the state: risk_on, mixed, risk_off or stressed. A calendar source the space binds adds the day's calendar. The campaign's regimeCaps may cap each state's gross exposure and the biases (long, short, neutral) its decisions may take. The decide contract refuses a decision that opens theses past them, and it holds each thesis by its own direction. A cycle whose regime cannot be gathered still runs on every slot. Its decision names the state unavailable, and the decide contract refuses any new thesis under it. Its closes, its record and its completion run as on any other cycle. A decide that fails, or whose contract cannot be checked, opens nothing. The cycle then decides unavailable, still closes, records and completes, and the cycle doc names the fault. The day's pre-market note at /research/{tradingDay}/pre-market.md reaches decide as evidence, cut at a fixed size and marked truncated. A note read that fails leaves decide without it. The cycle still closes, records and completes, and the cycle doc names the read fault. The cycle doc and the snapshot carry the state each decision was made under, with the regime, or null where it was unavailable. The cycle doc also records the read the regime came from: its binding, asOf and count.

**Approved theses only**: a cycle opens a thesis only as an instance of a reviewed entry of the approved set at \`${APPROVED_THESES_PATH_TEMPLATE}\` for its slot. The decide contract refuses any other. A slot with no approved set, or an empty one, resolves and records and opens nothing. Resolution of open theses reads no approved set.

**Self-healing cadence**: the schedule names the slot in the run input (\`slot\`, plus \`slotIndex\` for intraday firings). Absent, the slot derives from the exchange clock. Runs are idempotent per (tradingDay, slot) via the ledger's cycle docs, and resolution always processes everything pending since the last completed cycle — a missed slot loses nothing and is recorded honestly in the cycle-reliability record.

**Close report**: the after_close cycle alone writes the close report at \`${CLOSE_REPORT_PATH_TEMPLATE}\`, after its cycle doc. It covers the whole trading day. The cycle reads its cycle doc and snapshot back from the ledger, and an agent lists every resolution and opening the day's cycle docs record, each with the slot of its cycle. A reflection gives one reason per resolution, its account of why the thesis resolved, and candidate changes for the next campaign boundary. Both contracts read the cycle docs and refuse an unknown thesis, a wrong outcome or slot, and an entry left out. The cycle records the reflection in the ledger under /portfolio/theses/reflections/ once per trading day, with the day's resolutions and openings. A duplicate after_close trigger reads it back, runs no agent and writes a byte-identical report. Every metric, count, per-arm figure and cost is bound from the docs, the recorded lists and the campaign, never copied by an agent. Each candidate change is an observation tied to the docs it rests on, never a decision. The close report is a record only: no task reads it, and it changes no campaign, skill or config. The Strategy Desk reads the Trading Reflection journal, never the close report.

**Two-layer measurement**: Layer-1 process metrics (cycle reliability, thesis discipline, resolution rate, calibration, loop health) derive from the ledger and are the primary signal. Layer-2 outcome metrics (benchmark-relative return, Sharpe, drawdown) are read only at pre-registered boundaries — raw daily P&L is not a signal anywhere.

**Prerequisites**: Alpaca paper API credentials configured once after bundle install. The operator creates the schedules: one pre-market, one shortly after the open, hourly intraday firings and one after the close, each naming its slot.`,
  tags: ['alpaca', 'trading', 'paper', 'theses', 'campaigns'],
  bundle: {
    workflow: {
      slug: 'daily-trading-cycle',
      name: 'Daily Trading Cycle',
      description:
        'One thesis-driven trading cycle on the Alpaca paper account: ingest state, resolve open theses, gather the market regime, decide new ones under campaign and per-regime caps, execute orders, record the cycle to the ledger.',
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
      runInputs: CYCLE_RUN_INPUTS,
      tasks: [
        {
          taskId: 'ingest-clock',
          name: 'Ingest market clock',
          goal: 'Read the exchange clock — the timestamp anchors the trading day, the open/close boundaries decide the slot when the run input names none.',
          type: 'operation' as const,
          operation: 'api.http.call',
          retryability: 'safe' as const,
          // The entry task's contract is the skill's input surface: a run input missing
          // from it is refused at start. resolve-theses reads all three.
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
              tradingDay: {
                kind: 'run_input' as const,
                bindAs: 'tradingDay',
                path: 'tradingDay',
                schema: TRADING_DAY_INPUT_SCHEMA,
              },
            },
          },
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
            requestedSlot: { kind: 'run_input' as const, path: 'slot' },
            requestedSlotIndex: { kind: 'run_input' as const, path: 'slotIndex' },
            requestedTradingDay: { kind: 'run_input' as const, path: 'tradingDay' },
            maxThesesPerDay: { kind: 'campaign_input' as const, path: 'maxThesesPerDay' },
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
                'maxThesesPerDay',
                'thesesOpenedToday',
                'remainingThesesToday',
                'coverageNote',
              ],
              additionalProperties: false,
              allOf: RESOLVE_SLOT_RULES,
              properties: {
                tradingDay: {
                  type: 'string',
                  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
                  description:
                    'The trading day this cycle belongs to, derived from the clock. Where `requestedTradingDay` is given and names another day, this cycle runs no slot: `proceed: false`.',
                },
                slot: {
                  ...SLOT_SCHEMA,
                  description:
                    'The slot `requestedSlot` names, when given. Otherwise derived from the clock. Every later task pins this value and holds the actions its slot allows.',
                },
                slotIndex: {
                  ...SLOT_INDEX_SCHEMA,
                  description: `The intraday firing number: \`requestedSlotIndex\` when given, otherwise ${INTRADAY_INDEX_RULE}. An integer on an intraday slot, null on every other slot.`,
                },
                maxThesesPerDay: {
                  type: 'integer',
                  minimum: 0,
                  description:
                    'The campaign’s `maxThesesPerDay`, copied from your input. It is pinned to the campaign.',
                },
                thesesOpenedToday: {
                  type: 'array',
                  uniqueItems: true,
                  items: { type: 'string' },
                  description:
                    'Every thesisId the cycle docs of this trading day list as opened, in any earlier slot.',
                },
                remainingThesesToday: {
                  type: 'integer',
                  minimum: 0,
                  description:
                    'maxThesesPerDay less the length of thesesOpenedToday, floored at 0, and 0 on after_close, which opens nothing. The contract refuses any other value. It bounds how many theses decide may form this cycle.',
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
            derivedFrom: [
              {
                bindingId: 'theses-per-day-pin',
                from: '$campaign',
                binding: 'value:$.maxThesesPerDay',
                target: '$.maxThesesPerDay.const',
              },
            ],
            // The pin above makes maxThesesPerDay the campaign's. This ref ties
            // remainingThesesToday to it and to thesesOpenedToday, which the
            // decide contract then binds as its theses ceiling.
            validatorRefs: ['trading.theses-day-budget'],
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'tradingDay', toState: 'tradingDay' },
            { kind: 'output_path' as const, path: 'slot', toState: 'slot' },
          ],
        },

        ...REGIME_CONTEXT_TASKS,

        {
          taskId: 'decide',
          name: 'Decide new theses',
          goal: DAILY_CYCLE_DECIDE_PROMPT,
          type: 'agent' as const,
          dependsOn: ['regime-state', 'read-pre-market'],
          when: CYCLE_PROCEED_GATE,
          // A decision that cannot be made or checked must not stop the closes,
          // the record or the completion. decision-state names it unavailable.
          optional: true,
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
            thesesOpenedToday: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'thesesOpenedToday',
            },
            remainingThesesToday: {
              kind: 'task_output' as const,
              taskId: 'resolve-theses',
              path: 'remainingThesesToday',
            },
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
            regimeName: { kind: 'campaign_input' as const, path: 'regimeName' },
            hypotheses: { kind: 'campaign_input' as const, path: 'hypotheses' },
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
            regimeCaps: { kind: 'campaign_input' as const, path: 'regimeCaps' },
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
              // Campaign-1 evidence classes are the tool surface: per-instrument
              // OHLCV + index context that is itself price data. No news tool —
              // later campaigns widen evidence by widening this grant.
              // No memory write: a task grant carries no path scope, and a put
              // could replace the approved set this task is gated on. decide
              // writes nothing it needs — its theses and rationale are its
              // output, and resolve-theses keeps the market-data cache.
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
          // The structural risk-gate: campaign caps land in this schema at
          // delegation time, so an out-of-cap thesis is a validation error the
          // agent must fix — not a rule it is asked to remember. The approved
          // set is a document, so a validatorRef reads it at submission.
          outputContract: {
            schema: {
              type: 'object',
              required: [
                'tradingDay',
                'regimeName',
                'slot',
                'slotIndex',
                'marketState',
                'bias',
                'approvedSetFault',
                'theses',
                'projectedGrossExposurePct',
                'decisionRationale',
              ],
              additionalProperties: false,
              allOf: [...DECIDE_SLOT_RULES, ...DECIDE_REGIME_RULES],
              properties: {
                ...DECIDE_IDENTITY_PROPERTIES,
                ...DECIDE_REGIME_PROPERTIES,
                tradingDay: {
                  ...DECIDE_IDENTITY_PROPERTIES.tradingDay,
                  description:
                    'This cycle’s trading day, copied from your input. It is pinned. The approved set is read for it, and the per-arm budget counts the theses each arm opened earlier that day.',
                },
                regimeName: {
                  type: 'string',
                  description: 'The campaign’s regimeName, copied from your input. It is pinned.',
                },
                ...DECIDE_SET_FAULT_PROPERTY,
                slot: {
                  ...SLOT_SCHEMA,
                  description:
                    'This cycle’s slot, copied from your input. It is pinned, and it decides what this output may hold: no theses on after_close, an entry condition on every pre_market thesis.',
                },
                theses: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: [
                      'thesisId',
                      'hypothesisId',
                      'approvedId',
                      'reviewRunId',
                      'instrument',
                      'direction',
                      'rationale',
                      'entryCondition',
                      'falsificationCriterion',
                      'confirmationCriterion',
                      'deadlineTradingDays',
                      'sizePct',
                      'confidence',
                    ],
                    additionalProperties: false,
                    properties: {
                      thesisId: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{2,63}$' },
                      hypothesisId: {
                        type: 'string',
                        description:
                          'The id of the campaign hypothesis this thesis is an instance of, the one its approved-set entry names. Only the campaign’s own ids validate. Each arm may open at most its thesisBudgetPerDay theses in one trading day, earlier slots included.',
                      },
                      ...THESIS_APPROVAL_PROPERTIES,
                      instrument: { type: 'string' },
                      direction: { enum: ['long', 'short'] },
                      rationale: { type: 'string', minLength: 1, maxLength: 1500 },
                      entryCondition: {
                        type: ['string', 'null'],
                        minLength: 1,
                        maxLength: 500,
                        description:
                          'Price-checkable condition that makes the entry due (e.g. "trades above 187.40 after the open"). The entry waits as a deferred intention until an open-market cycle reads it as met. null enters at the next open-market submission. Required on pre_market, which sees no price of the session.',
                      },
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
                bindingId: 'hypothesis-arms',
                from: '$campaign',
                binding: 'enum:$.hypotheses[*].id',
                target: '$.theses.items.hypothesisId.enum',
              },
              {
                bindingId: 'decide-regime-pin',
                from: '$campaign',
                binding: 'value:$.regimeName',
                target: '$.regimeName.const',
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
              // The day's remaining cap: theses opened by earlier slots of the
              // trading day count against maxThesesPerDay.
              {
                bindingId: 'theses-remaining-today',
                from: 'resolve-theses',
                binding: 'value:$.remainingThesesToday',
                target: '$.theses.maxItems',
              },
              {
                bindingId: 'decide-slot-pin',
                from: 'resolve-theses',
                binding: 'value:$.slot',
                target: '$.slot.const',
              },
              ...DECIDE_IDENTITY_PINS,
              DECIDE_REGIME_PIN,
            ],
            // Each arm's daily budget: the campaign's thesisBudgetPerDay less
            // the theses the ledger shows the arm opened earlier that day. The
            // regime caps are read from the campaign by the state pinned above.
            validatorRefs: [
              APPROVED_THESES_VALIDATOR_REF,
              'trading.thesis-arm-budget',
              REGIME_CAPS_VALIDATOR_REF,
            ],
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
              required: ['slot', 'orderResults', 'submittedCount', 'deferredCount', 'failedCount'],
              additionalProperties: false,
              allOf: [...EXECUTE_SLOT_RULES, ...ORDER_APPROVAL_RULES],
              properties: {
                slot: {
                  ...SLOT_SCHEMA,
                  description:
                    'This cycle’s slot, copied from your input. It is pinned, and it decides what this output may hold: pre_market submits nothing and defers entries only, after_close settles closes only.',
                },
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
                          'Order quantity. A close submits the held quantity verbatim — fractional allowed, a long opened by notional holds fractional shares. A short entry is always whole shares: the broker rejects fractional short sales.',
                      },
                      notional: {
                        type: ['string', 'null'],
                        description:
                          'Dollar sizing — long entries; for a short entry, the target the whole-share qty was derived from.',
                      },
                      entryCondition: {
                        type: ['string', 'null'],
                        description:
                          'The entry condition of the thesis behind an entry, copied verbatim and stored on its intention doc. null for a close and for an entry with none.',
                      },
                      disposition: {
                        enum: ['submitted', 'duplicate', 'deferred', 'expired', 'failed'],
                        description:
                          'submitted = the broker acknowledged the order (2xx + order id). duplicate = the client order id already exists at the broker — found in the pre-submission orders list, or rejected as already used on submit; either way the prior submission stands, counted in neither submittedCount nor failedCount. deferred = recorded as an intention: the market is closed, the slot is pre_market, or the entry condition is not met yet. expired = a pending entry intention dropped unsubmitted (thesis deadline passed, or no open-thesis doc behind it). failed = the broker rejected it (any other non-2xx), or the order could not be sized at all (a short entry whose share price exceeds its target — no broker call).',
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
            derivedFrom: [
              {
                bindingId: 'execute-slot-pin',
                from: 'resolve-theses',
                binding: 'value:$.slot',
                target: '$.slot.const',
              },
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
                'lensRecordGaps',
              ],
              additionalProperties: false,
              allOf: [...RECORD_ARM_TABLE_RULES, ...RECORD_SET_FAULT_RULES],
              properties: {
                runSummary: { type: 'string', minLength: 1, maxLength: 1500 },
                armTable: ARM_TABLE_SCHEMA,
                cycleCompleted: { type: 'integer', const: 1 },
                ...RECORD_SET_FAULT_METRIC,
                ...LENS_RECORD.RECORD_LENS_GAP_METRIC,
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
            ],
            validatorRefs: ['trading.arm-table', LENS_RECORD.LENS_RECORD_VALIDATOR_REF],
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
              'Every entry order derives from a validated thesis (hypothesis arm, instrument, direction, rationale, falsification, confirmation, deadline, size) written before the order. Every thesis instantiates an approved-set entry and carries its approvedId and review run id.',
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
          LENS_RECORD.LENS_PREDICTIVENESS_GOAL,
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
          {
            name: 'gross-exposure-within-cap',
            type: 'threshold' as const,
            metric: 'grossExposurePct',
            operator: 'lte' as const,
            target: { $campaign: 'maxGrossExposurePct' },
          },
          APPROVED_SET_SOUND_CRITERION,
          LENS_RECORD.LENS_RECORD_CARRIED_CRITERION,
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
        'One run = one trading-cycle slot on the Alpaca paper account. Requires an active campaign. Runs fire from the pre-market, open, intraday and after-close schedules, each passing inputs { slot }, and self-heal missed slots. A manual run is the last resort: without a slot it derives one from the clock. Runs are idempotent per (tradingDay, slot). Orders submit only while the market is open and never on pre_market. Closed-market cycles defer them as intentions.',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'The thesis — not the trade — is the unit of decision, measurement, and learning: every order derives from a validated thesis with written falsification/confirmation criteria and a deadline, so each resolution is a clean truth event independent of portfolio noise. The regime lives in the campaign contract: caps, named hypotheses with daily budgets, and boundary rules, frozen mid-window. Every thesis cites its arm, and the per-arm table is counted from the ledger. Campaign caps are bound into the decide contract at delegation time (structural risk-gate, no human gate on paper), a thesis opens only from the reviewed approved set for its (tradingDay, slot), order authority is isolated to one task, and cycles are idempotent per (tradingDay, slot) via the ledger so missed slots self-heal. What each slot may do is a schema conditional keyed on the pinned slot. Per-regime caps hold each decision to the recomputed market regime it was made under.',
  },
};

export { DAILY_TRADING_CYCLE };
