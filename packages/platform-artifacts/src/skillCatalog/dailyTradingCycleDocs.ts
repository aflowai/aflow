import {
  CYCLE_DOC_SET_FAULT_PROPERTY,
  OPENED_APPROVALS_SCHEMA,
} from './dailyTradingCycleApproved.js';
import { ARM_TABLE_SCHEMA } from './dailyTradingCycleCampaign.js';
import { RESOLUTION_OUTCOMES, SLOT_INDEX_SCHEMA, SLOT_SCHEMA } from './dailyTradingCycleSlots.js';
import * as MEASURES from './dailyTradingCycleMeasures.js';

export const CYCLE_DOC_SCHEMA = {
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
    coverageNote: { type: 'string', minLength: 1, maxLength: 8000 },
    thesesOpened: { type: 'array', items: { type: 'string' } },
    ...OPENED_APPROVALS_SCHEMA,
    ...CYCLE_DOC_SET_FAULT_PROPERTY,
    thesesResolved: {
      type: 'array',
      items: {
        type: 'object',
        required: ['thesisId', 'hypothesisId', 'outcome', ...MEASURES.RECORDED],
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
          ...MEASURES.RECORDED_REALIZED_R_PROPERTY,
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
export const SNAPSHOT_DOC_SCHEMA = {
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
    'benchmarkClose',
  ],
  additionalProperties: false,
  properties: {
    equity: { type: 'number' },
    cash: { type: 'number' },
    positions: { type: 'array' },
    brokerGrossExposurePct: { type: 'number' },
    grossExposurePct: { type: 'number' },
    orphanFlattens: { type: 'array' },
    ...MEASURES.SNAPSHOT_BENCHMARK_PROPERTY,
    armTable: {
      ...ARM_TABLE_SCHEMA,
      description: 'The same table as armTable, or null where armTable is null.',
    },
  },
};
