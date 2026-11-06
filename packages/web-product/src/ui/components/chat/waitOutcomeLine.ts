import {
  readWaitOutcomeMessage,
  WAIT_OUTCOME_ACTOR_ID,
  type PullRequestChange,
  type WaitOutcomeMessage,
} from '@aflow/schemas';

/** A room message the platform posted to tell the agent that its wait ended. */
export function isWaitOutcomeMessage(message: { role: string; authorUserId?: string }): boolean {
  return message.role === 'user' && message.authorUserId === WAIT_OUTCOME_ACTOR_ID;
}

const PULL_REQUEST_CHANGE: Record<PullRequestChange, string> = {
  checks_green: 'its checks passed',
  checks_failed: 'a check failed',
  merged: 'it merged',
  conflicting: 'it conflicts with its base branch',
  changes_requested: 'a review asked for changes',
  closed: 'it closed without merging',
};

const RUN_STATUS: Record<string, string> = {
  completed: 'it completed',
  failed: 'it failed',
  cancelled: 'it was cancelled',
};

const RESOLUTION: Record<string, string> = {
  submit: 'it was answered',
  approve: 'it was approved',
  reject: 'it was rejected',
  ratify: 'it was ratified',
  dismiss: 'it was dismissed',
  reassign: 'it was reassigned',
};

function waitedFor(message: WaitOutcomeMessage): string {
  switch (message.kind) {
    case 'pull_request.changed':
      return `pull request ${message.subject}`;
    case 'run.ended':
      return 'a run';
    case 'plan.node.status_changed':
      return message.planNodeTitle !== undefined
        ? `plan step “${message.planNodeTitle}”`
        : 'a plan step';
    case 'gate.resolved':
      return 'an Action Center item';
  }
}

function phrase(
  words: Readonly<Record<string, string>>,
  key: string | undefined,
  otherwise: string,
): string {
  return key !== undefined && Object.hasOwn(words, key) ? (words[key] ?? otherwise) : otherwise;
}

function whatHappened(message: WaitOutcomeMessage): string {
  if (message.endedBy === 'window_closed') return 'its time ran out with no news';
  const { change, status, resolution } = message.detail;
  switch (message.kind) {
    case 'pull_request.changed':
      return phrase(PULL_REQUEST_CHANGE, change, 'it changed');
    case 'run.ended':
      return phrase(RUN_STATUS, status, 'it ended');
    case 'plan.node.status_changed':
      return status !== undefined ? `it is now ${status}` : 'its status changed';
    case 'gate.resolved':
      return phrase(RESOLUTION, resolution, 'it was resolved');
  }
}

/**
 * The one line a person reads for a wait's room message: that a wait ended,
 * what it was for and what ended it. The message itself is written for the
 * agent, so words this does not recognise still read as a wait that ended.
 */
export function describeWaitOutcomeNotice(body: string): string {
  const message = readWaitOutcomeMessage(body);
  if (message === null) return 'A wait ended.';
  return `Wait for ${waitedFor(message)} ended: ${whatHappened(message)}.`;
}
