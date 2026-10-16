import type { SpaceWorkflowRunSummary } from '../../hooks/use-space-workflow-runs.js';
import type { Session } from '../../lib/types.js';
import { humanizePauseReason } from './WorkbenchRunRow.js';

/**
 * Whether a conversation is live, read off what the Workbench already holds.
 *
 * Two things make a conversation live, and a row says both: the agent is in a
 * turn — its session's hot status, which the list carries — or a run it started
 * is still going, a commission or a publication, from the space's active-run
 * feed. Neither is fetched per row: the list and the feed are each one query,
 * refreshed by the space's entity events.
 */
export interface ConversationRunPhase {
  runId: string;
  /** The skill the run is of, as the space names it. */
  name: string;
  status: 'running' | 'paused';
  /** What the run is at, said as a person would: `running`, `Needs a decision`. */
  phase: string;
}

export interface ConversationLiveState {
  /** True while the agent is taking a turn — working, or waiting on a delegate. */
  inTurn: boolean;
  /** The runs this conversation started that have not ended, paused first. */
  runs: ConversationRunPhase[];
}

/** Statuses in which the agent is doing something rather than resting on you. */
const IN_TURN_STATUSES: ReadonlySet<string> = new Set([
  'QUEUED',
  'RUNNING',
  'WAITING_ON_CHILD',
  'CANCELLING',
]);

/** A run's slug read as a name, where the space's list does not name it. */
export function nameFromSlug(slug: string): string {
  const words = slug.replace(/[_-]+/g, ' ').trim();
  return words.length === 0 ? slug : words.charAt(0).toUpperCase() + words.slice(1);
}

export function runPhase(run: Pick<SpaceWorkflowRunSummary, 'status' | 'pausedReason'>): string {
  if (run.status === 'paused') {
    return run.pausedReason ? humanizePauseReason(run.pausedReason) : 'paused';
  }
  return 'running';
}

/**
 * The runs a conversation waits on, keyed by conversation.
 *
 * A run belongs to the conversation that steers it: the session that started
 * it, or the root of the chain it was started from — a commission a delegate
 * started is still the operator's conversation's work.
 */
export function runsByConversation(
  runs: readonly SpaceWorkflowRunSummary[],
  workflowNames: ReadonlyMap<string, string>,
): Map<string, ConversationRunPhase[]> {
  const byConversation = new Map<string, ConversationRunPhase[]>();
  for (const run of runs) {
    const status =
      run.status === 'paused' ? 'paused' : run.status === 'running' ? 'running' : undefined;
    if (status === undefined) continue;
    const phase: ConversationRunPhase = {
      runId: run.runId,
      name: workflowNames.get(run.workflowSlug) ?? nameFromSlug(run.workflowSlug),
      status,
      phase: runPhase(run),
    };
    const owners = new Set(
      [run.rootSessionId, run.sessionId].filter((id): id is string => typeof id === 'string'),
    );
    for (const owner of owners) {
      const list = byConversation.get(owner) ?? [];
      list.push(phase);
      byConversation.set(owner, list);
    }
  }
  // A paused run is waiting on someone, which is the more urgent of the two.
  for (const list of byConversation.values()) {
    list.sort((a, b) => (a.status === b.status ? 0 : a.status === 'paused' ? -1 : 1));
  }
  return byConversation;
}

const NO_RUNS: ConversationRunPhase[] = [];

export function conversationLiveState(
  session: Pick<Session, 'sessionId' | 'status'>,
  runsFor: ReadonlyMap<string, ConversationRunPhase[]>,
): ConversationLiveState {
  return {
    inTurn: IN_TURN_STATUSES.has(session.status),
    runs: runsFor.get(session.sessionId) ?? NO_RUNS,
  };
}

/** Whether there is anything live to say about the conversation at all. */
export function isLive(state: ConversationLiveState): boolean {
  return state.inTurn || state.runs.length > 0;
}
