/**
 * How a cycle comes to the day's set. It reads whether the day has one. Where
 * it has none and the schedule named the desk's folder, the cycle runs the
 * Strategy Desk and waits for it, so the desk and the cycle run in one firing.
 * It then reads the set as it stands and tallies it by code, and decide reads
 * the approved candidates from the tally.
 */
import type { WorkflowRunDecideRule } from '@aflow/schemas';
import { APPROVED_THESES_PATH_TEMPLATE, DESK_TALLY_DERIVER } from './dailyTradingCycleApproved.js';
import { CYCLE_PROCEED_GATE } from './dailyTradingCycleGather.js';
import { bind } from './localPrShepherdWiring.js';
import { STRATEGY_DESK_SLUG } from './strategyDeskRules.js';

export const CHECK_SET_TASK_ID = 'check-set';
export const SET_STATE_TASK_ID = 'set-state';
export const RUN_DESK_TASK_ID = 'run-desk';
export const READ_SET_TASK_ID = 'read-set';
export const TALLY_SET_TASK_ID = 'tally-set';

const TRADING_DAY = { kind: 'task_output' as const, taskId: 'resolve-theses', path: 'tradingDay' };
const SET_PATH = { $concat: ['/research/', bind('tradingDay'), '/approved-theses.json'] };

const CHECK_SET_TASK = {
  taskId: CHECK_SET_TASK_ID,
  name: 'Check for the day’s set',
  goal: `Read whether ${APPROVED_THESES_PATH_TEMPLATE} exists for this cycle’s trading day. No set reads as absent.`,
  type: 'operation' as const,
  operation: 'memory.store.get',
  dependsOn: ['resolve-theses'],
  when: CYCLE_PROCEED_GATE,
  optional: true,
  retryability: 'safe' as const,
  inputBindings: { tradingDay: TRADING_DAY },
  inputTemplate: { target: { path: SET_PATH }, view: 'stat', ifMissing: 'absent' },
  outputProjection: { path: { path: 'stat.path', onMissing: 'null' as const } },
};

export const SET_STATE_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.setPath != null' },
    decision: 'current',
    reason: 'The day has a set, so the cycle decides from it.',
  },
  {
    when: { expression: 'state.bindingId == null' },
    decision: 'no_desk',
    reason:
      'The day has no set and the run named no desk folder, so the cycle decides with no approved candidate. Pass bindingId on the schedule to run the desk here.',
  },
];

const SET_STATE_TASK = {
  taskId: SET_STATE_TASK_ID,
  name: 'Decide whether to run the desk',
  goal: 'Decide by rule whether the day’s set is current, or the desk runs first. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [CHECK_SET_TASK_ID],
  when: CYCLE_PROCEED_GATE,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    setPath: { kind: 'task_output' as const, taskId: CHECK_SET_TASK_ID, path: 'path' },
    bindingId: { kind: 'run_input' as const, path: 'bindingId' },
  },
  inputTemplate: {
    state: { setPath: bind('setPath'), bindingId: bind('bindingId') },
    rules: SET_STATE_RULES,
    otherwise: {
      decision: 'run_desk',
      reason: 'The day has no set, so the cycle runs the desk and decides from the set it writes.',
    },
  },
  outputProjection: {
    decision: { path: 'decision', onMissing: 'error' as const },
    reason: { path: 'reason', onMissing: 'error' as const },
  },
};

const RUN_DESK_TASK = {
  taskId: RUN_DESK_TASK_ID,
  name: 'Run the Strategy Desk',
  goal: 'Start the Strategy Desk for this trading day and wait for it to write the set. A desk that cannot start or ends without a set leaves the cycle to decide with what the day holds.',
  type: 'operation' as const,
  operation: 'workflow.run.start',
  dependsOn: [SET_STATE_TASK_ID],
  when: {
    expression: `tasks.${SET_STATE_TASK_ID}.output.decision == 'run_desk'`,
    onMissingRef: 'skip' as const,
  },
  optional: true,
  retryability: 'unsafe' as const,
  maxAttempts: 1,
  inputBindings: {
    tradingDay: TRADING_DAY,
    bindingId: { kind: 'run_input' as const, path: 'bindingId' },
  },
  inputTemplate: {
    slug: STRATEGY_DESK_SLUG,
    catalogId: STRATEGY_DESK_SLUG,
    inputs: { bindingId: bind('bindingId'), tradingDay: bind('tradingDay') },
    wait: 'until_complete',
  },
  outputProjection: {
    deskRunId: { path: 'runId', onMissing: 'null' as const },
    deskOutcome: { path: 'result.output.deskOutcome', onMissing: 'null' as const },
  },
};

const READ_SET_TASK = {
  taskId: READ_SET_TASK_ID,
  name: 'Read the day’s set',
  goal: 'Read the day’s set as it stands now, after any desk this cycle ran.',
  type: 'operation' as const,
  operation: 'memory.store.get',
  dependsOn: [SET_STATE_TASK_ID, RUN_DESK_TASK_ID],
  when: CYCLE_PROCEED_GATE,
  optional: true,
  retryability: 'safe' as const,
  inputBindings: { tradingDay: TRADING_DAY },
  inputTemplate: { target: { path: SET_PATH }, view: 'content', ifMissing: 'absent' },
  outputProjection: { content: { path: 'data', onMissing: 'null' as const } },
};

const TALLY_SET_TASK = {
  taskId: TALLY_SET_TASK_ID,
  name: 'Tally the set',
  goal: 'Compute by code which candidates of the day’s set the review approved, and why each other one was turned down. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.derive',
  dependsOn: [READ_SET_TASK_ID],
  when: CYCLE_PROCEED_GATE,
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    set: { kind: 'task_output' as const, taskId: READ_SET_TASK_ID, path: 'content' },
  },
  inputTemplate: { deriver: DESK_TALLY_DERIVER, args: { set: bind('set') } },
  outputProjection: {
    approved: { path: 'value.approved', onMissing: 'error' as const },
    turnedDown: { path: 'value.turnedDown', onMissing: 'error' as const },
    setNote: { path: 'value.setNote', onMissing: 'error' as const },
  },
};

export const CYCLE_SET_TASKS = [
  CHECK_SET_TASK,
  SET_STATE_TASK,
  RUN_DESK_TASK,
  READ_SET_TASK,
  TALLY_SET_TASK,
];
