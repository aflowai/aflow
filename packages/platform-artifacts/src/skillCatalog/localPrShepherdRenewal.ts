import { SCHEDULE_RENEWAL_WINDOW, type WorkflowRunDecideRule } from '@aflow/schemas';
import { bind, ctx, out, runInput, SKIP } from './localPrShepherdWiring.js';

/**
 * The schedule renews itself: a pass started by a schedule reads it
 * and, within the window of its firing cap, creates its successor, so the
 * shepherd never goes quiet when a schedule's firings run out. A schedule has
 * one successor, so overlapping passes that both find it due create one.
 */

/** The run input the starting schedule's id arrives in, from the Local PR Shepherd agent. */
export const SCHEDULE_INPUT = 'scheduleId';

export const SCHEDULE_ID_SCHEMA = {
  type: 'string',
  format: 'uuid',
  description: 'The schedule that started this pass, which the pass renews as it nears its cap.',
};

const SCHEDULED_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.scheduleId != null' },
    decision: 'scheduled',
    reason: 'A schedule started the pass: it is read, and renewed where its firings run out.',
  },
];

const SCHEDULED_OTHERWISE = {
  decision: 'unscheduled',
  reason: 'No schedule started the pass: there is none to renew.',
};

export const READ_FIRING_TASK = {
  taskId: 'read-firing',
  name: 'Read whether a schedule started the pass',
  goal: 'Decide whether a schedule started this pass, so that schedule is read and renewed before its firings run out.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  // The folder's read is the run's one root task; this follows it, so a pass
  // whose folder cannot be read renews nothing and the next pass does.
  dependsOn: ['read-folder'],
  retryability: 'safe' as const,
  inputBindings: { scheduleId: runInput(SCHEDULE_INPUT) },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    state: { scheduleId: bind('scheduleId') },
    rules: SCHEDULED_RULES,
    otherwise: SCHEDULED_OTHERWISE,
  },
};

export const READ_SCHEDULE_TASK = {
  taskId: 'read-schedule',
  name: 'Read the schedule that started the pass',
  goal: 'Read the schedule that started this pass: whether it is active and how many of its firings are left.',
  type: 'operation' as const,
  operation: 'agent.schedule.get',
  when: { expression: "tasks.read-firing.output.decision == 'scheduled'", onMissingRef: SKIP },
  // A schedule that cannot be read is renewed by a later pass, inside the window.
  optional: true,
  retryability: 'safe' as const,
  inputBindings: { scheduleId: runInput(SCHEDULE_INPUT) },
  context: ctx('agent.schedule.get'),
  inputTemplate: { scheduleId: bind('scheduleId') },
};

export const RENEW_SCHEDULE_TASK = {
  taskId: 'renew-schedule',
  name: 'Renew the schedule before its firings run out',
  goal: `Where the schedule that started this pass is active and within ${String(SCHEDULE_RENEWAL_WINDOW)} firings of its cap, create its successor — the same agent, cron, input and expiry — which takes over from it, so the passes go on without a hand.`,
  type: 'operation' as const,
  operation: 'agent.schedule.create',
  when: { expression: 'tasks.read-schedule.output.renewalDue == true', onMissingRef: SKIP },
  // The pass tends its pull request whether or not the schedule renewed; a
  // later pass inside the window tries again.
  optional: true,
  // A schedule has one successor: a second attempt returns the first's.
  retryability: 'safe' as const,
  maxAttempts: 2,
  inputBindings: { scheduleId: out(READ_SCHEDULE_TASK.taskId, 'id') },
  context: ctx('agent.schedule.create'),
  inputTemplate: { renews: bind('scheduleId') },
};

export const RENEWAL_TASKS = [READ_FIRING_TASK, READ_SCHEDULE_TASK, RENEW_SCHEDULE_TASK];
