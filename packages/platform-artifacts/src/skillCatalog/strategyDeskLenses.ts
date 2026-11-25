/**
 * The desk's one review pass: seven lens runs side by side, each with its
 * own focus and only the reads its lens needs, then the desk reviewer, who
 * reads every lens finding and holds the one veto. Each is a harness task of
 * the desk run. The tally is code (`strategyDeskTally.ts`), run wherever the
 * set is read, so no task folds the verdicts.
 */
import { bind, ctx, out, runInput, SKIP } from './localPrShepherdWiring.js';
import { DESK_LENSES, LENS_NAMES, type DeskLens } from './strategyDeskTally.js';
import { DESK_REVIEWER_TASK, deskLensTask } from './strategyDeskProse.js';
import {
  DESK_REVIEW_RESULT_SCHEMA,
  DESK_REVIEW_TASK_ID,
  lensResultSchema,
  PROPOSAL_TASK_ID,
  READ_CAMPAIGN_TASK_ID,
  READ_LEDGER_TASK_ID,
  STRATEGIST_TASK_ID,
} from './strategyDeskRules.js';
import { READ_GOALS_TASK_ID, READ_PRINCIPLES_TASK_ID } from './strategyPrinciples.js';
import { CAMPAIGN_CONTRACT_INPUT, campaignContractBindings } from './tradingCampaignRead.js';

export const lensTaskId = (lens: DeskLens) => `lens-${LENS_NAMES[lens]}`;

/** The ledger reads a lens may take. Every lens also reads the ledger note, which names failed reads. */
type LedgerRead =
  | 'openTheses'
  | 'resolvedTheses'
  | 'recentCycles'
  | 'priorDesk'
  | 'operatorNotes'
  | 'universeSnapshots'
  | 'news'
  | 'journal';
type ProposalRead = 'bias' | 'regimeRead';

/** What each lens reads: only what its lens needs, beside the candidates every lens reviews. */
export const DESK_LENS_READS: Record<
  DeskLens,
  { ledger: readonly LedgerRead[]; proposal: readonly ProposalRead[]; campaign: boolean }
> = {
  fundamentals: { ledger: ['universeSnapshots', 'news'], proposal: [], campaign: false },
  macro: { ledger: ['news'], proposal: ['regimeRead', 'bias'], campaign: false },
  technical: { ledger: ['universeSnapshots'], proposal: ['regimeRead'], campaign: false },
  priorLearnings: { ledger: ['resolvedTheses', 'journal'], proposal: [], campaign: false },
  priorDecisions: {
    ledger: ['recentCycles', 'priorDesk', 'operatorNotes'],
    proposal: [],
    campaign: true,
  },
  risk: { ledger: ['openTheses'], proposal: ['regimeRead'], campaign: true },
  principles: { ledger: [], proposal: [], campaign: true },
};

const HARNESS_TIMEOUT_MS = 40 * 60_000;

/** The gate every review task runs under: the strategist proposed something. */
export const REVIEWING = {
  expression: `tasks.${PROPOSAL_TASK_ID}.output.decision == 'review'`,
  onMissingRef: SKIP,
};

const PRINCIPLES_LENS = {
  dependsOn: [READ_GOALS_TASK_ID, READ_PRINCIPLES_TASK_ID],
  bindings: {
    goals: out(READ_GOALS_TASK_ID, 'content'),
    principles: out(READ_PRINCIPLES_TASK_ID, 'content'),
  },
  inputs: { goals: bind('goals'), principles: bind('principles') },
};

function lensTask(lens: DeskLens) {
  const reads = DESK_LENS_READS[lens];
  const principles = lens === 'principles';
  return {
    taskId: lensTaskId(lens),
    name: `Review through the ${LENS_NAMES[lens]} lens`,
    goal: `Run the ${LENS_NAMES[lens]} lens on the harness over the folder: give the candidates its verdicts through this lens alone, with the reasons. A lens that returns nothing approves.`,
    type: 'operation' as const,
    operation: 'host.harness.run',
    dependsOn: [
      READ_CAMPAIGN_TASK_ID,
      READ_LEDGER_TASK_ID,
      PROPOSAL_TASK_ID,
      ...(principles ? PRINCIPLES_LENS.dependsOn : []),
    ],
    when: REVIEWING,
    // A lens with no result is silent, and silence approves.
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      bindingId: runInput('bindingId'),
      tradingDay: runInput('tradingDay'),
      reviewHarness: runInput('reviewHarness'),
      reviewModel: runInput('reviewModel'),
      candidates: out(STRATEGIST_TASK_ID, 'candidates'),
      ledgerNote: out(READ_LEDGER_TASK_ID, 'ledgerNote'),
      ...Object.fromEntries(
        reads.ledger.map((field) => [`ledger_${field}`, out(READ_LEDGER_TASK_ID, field)]),
      ),
      ...Object.fromEntries(
        reads.proposal.map((field) => [`proposal_${field}`, out(STRATEGIST_TASK_ID, field)]),
      ),
      ...(reads.campaign ? campaignContractBindings(READ_CAMPAIGN_TASK_ID) : {}),
      ...(principles ? PRINCIPLES_LENS.bindings : {}),
    },
    context: ctx('host.harness.run'),
    inputTemplate: {
      bindingId: bind('bindingId'),
      harness: bind('reviewHarness'),
      model: bind('reviewModel'),
      task: deskLensTask(lens),
      inputs: {
        focus: lens,
        tradingDay: bind('tradingDay'),
        candidates: bind('candidates'),
        ledger: {
          ledgerNote: bind('ledgerNote'),
          ...Object.fromEntries(reads.ledger.map((field) => [field, bind(`ledger_${field}`)])),
        },
        ...(reads.proposal.length > 0
          ? {
              proposal: Object.fromEntries(
                reads.proposal.map((field) => [field, bind(`proposal_${field}`)]),
              ),
            }
          : {}),
        ...(reads.campaign ? { campaign: CAMPAIGN_CONTRACT_INPUT } : {}),
        ...(principles ? PRINCIPLES_LENS.inputs : {}),
      },
      outputSchema: lensResultSchema(lens),
      resultRetries: 2,
      timeoutMs: HARNESS_TIMEOUT_MS,
    },
    outputProjection: {
      verdicts: { path: 'result.verdicts', onMissing: 'error' as const },
      summary: { path: 'result.summary', onMissing: 'error' as const },
      harness: { path: 'harness.id', onMissing: 'null' as const },
    },
  };
}

/** The lens findings by lens, bound from each lens task. A lens that failed binds nothing. */
export const LENS_FINDING_BINDINGS = Object.fromEntries(
  DESK_LENSES.map((lens) => [`lens_${lens}`, out(lensTaskId(lens), 'verdicts')]),
);

export const LENS_FINDINGS = Object.fromEntries(
  DESK_LENSES.map((lens) => [lens, bind(`lens_${lens}`)]),
);

const DESK_REVIEW_TASK = {
  taskId: DESK_REVIEW_TASK_ID,
  name: 'Review as the desk',
  goal: 'Run the desk reviewer on the harness: read every lens finding and the candidates, and veto a candidate only for a mistake, naming who found it and why. A reviewer that returns nothing vetoes nothing.',
  type: 'operation' as const,
  operation: 'host.harness.run',
  dependsOn: [PROPOSAL_TASK_ID, ...DESK_LENSES.map(lensTaskId)],
  when: REVIEWING,
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    bindingId: runInput('bindingId'),
    tradingDay: runInput('tradingDay'),
    reviewHarness: runInput('reviewHarness'),
    reviewModel: runInput('reviewModel'),
    candidates: out(STRATEGIST_TASK_ID, 'candidates'),
    ...campaignContractBindings(READ_CAMPAIGN_TASK_ID),
    ...LENS_FINDING_BINDINGS,
  },
  context: ctx('host.harness.run'),
  inputTemplate: {
    bindingId: bind('bindingId'),
    harness: bind('reviewHarness'),
    model: bind('reviewModel'),
    task: DESK_REVIEWER_TASK,
    inputs: {
      tradingDay: bind('tradingDay'),
      candidates: bind('candidates'),
      campaign: CAMPAIGN_CONTRACT_INPUT,
      lenses: LENS_FINDINGS,
    },
    outputSchema: DESK_REVIEW_RESULT_SCHEMA,
    resultRetries: 2,
    timeoutMs: HARNESS_TIMEOUT_MS,
  },
  outputProjection: {
    vetoes: { path: 'result.vetoes', onMissing: 'error' as const },
    summary: { path: 'result.summary', onMissing: 'error' as const },
    harness: { path: 'harness.id', onMissing: 'null' as const },
  },
};

/** The review pass: seven lenses, then the desk reviewer. */
export const DESK_REVIEW_TASKS = [...DESK_LENSES.map(lensTask), DESK_REVIEW_TASK];
