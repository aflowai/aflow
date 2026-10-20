import { SHEPHERD_LEASE_DOCUMENT, SHEPHERD_LEASE_ROOT } from '@aflow/schemas';
import { COMMISSIONS } from './localPrShepherdRemedies.js';
import {
  bind,
  ctx,
  DECIDED_TO_ACT,
  HEAD_REF,
  LEASE_TAKERS,
  leaseBindings,
  leaseValue,
  NUMBER,
  OURS,
  out,
  REPOSITORY,
  SKIP,
} from './localPrShepherdWiring.js';

/** `shepherd/<owner>/<repo>/<branch>/<document>` in the space's memory, beside the branch's lease. */
function branchDocument(document: string) {
  return {
    $concat: [
      `${SHEPHERD_LEASE_ROOT}/`,
      bind('owner'),
      '/',
      bind('repo'),
      '/',
      bind('headRef'),
      `/${document}`,
    ],
  };
}
const LEASE_PATH = branchDocument(SHEPHERD_LEASE_DOCUMENT);

const LEASE_HELD = {
  anyOf: LEASE_TAKERS.map((taskId) => `tasks.${taskId}.status == 'succeeded'`),
  onMissingRef: SKIP,
};

/** Every task that can still be running while the lease is held: the release waits for all of them. */
const LEASED_WORK = [
  ...LEASE_TAKERS,
  'read-failure',
  'read-failure-log-1',
  'read-failure-log-2',
  'read-failure-log-3',
  'classify-failure',
  'rerun-jobs',
  ...COMMISSIONS,
  'publish',
  'read-merge-outcome',
  'merge',
  'record-merge',
  // A merge's outcome is recorded before the lease goes, so the next holder reads it.
  'remember-merge-outcome',
];

/**
 * The lease, taken before anything is commissioned or merged: the run that
 * holds it, when it was taken, what it decided, and the check run and head it
 * acts on. Where there is
 * none it is created, never overwritten, so the second of two passes fails
 * here with nothing done. Where there is one, the rules found it stale — its
 * run ended, or it is past `SHEPHERD_LEASE_STALE_AFTER_MS` — and it is taken
 * over by overwriting exactly the lease that was read: a pass that took it
 * over first changed it, so a second takeover fails the same way.
 */
export function leaseTask(taskId: (typeof LEASE_TAKERS)[number]) {
  const takeover = taskId === 'lease-takeover';
  return {
    taskId,
    name: takeover ? 'Take over the stale lease' : 'Take the lease on the branch',
    goal: takeover
      ? "Overwrite the branch's stale lease — its run has ended, or it is older than the bound, and it is not held by a pass paused at its merge approval — with this pass's own, before anything is commissioned or merged, and only as it was read."
      : "Write the branch's lease in the space's memory before anything is commissioned or merged, holding the run, the time, the decision, and the check run and head this pass acts on.",
    type: 'operation' as const,
    operation: 'memory.store.put',
    // A merge takes the lease as a fix does.
    when: {
      allOf: [
        ...DECIDED_TO_ACT,
        `tasks.read-in-flight-lease.status ${takeover ? '==' : '!='} 'succeeded'`,
      ],
      onMissingRef: SKIP,
    },
    // Not optional: a lease another pass took first ends this one, and only
    // the pass that holds a lease releases it.
    retryability: 'safe' as const,
    maxAttempts: 1,
    failureInstruction:
      'The lease on this branch could not be taken — most often because another pass took it first, which is the lease doing its job. Nothing was commissioned or published by this pass.',
    inputBindings: {
      ...REPOSITORY,
      ...NUMBER,
      ...HEAD_REF,
      headSha: out('read-pr', 'data.headSha'),
      checkRunId: out('read-pr-checks', 'data.firstFailing.id'),
      decision: out('decide', 'decision'),
      runId: { kind: 'run_id' as const },
      takenAtMs: { kind: 'clock' as const },
      ...(takeover ? { staleHash: out('read-in-flight-lease', 'stat.contentHash') } : {}),
    },
    context: ctx('memory.store.put'),
    inputTemplate: {
      path: LEASE_PATH,
      writeMode: takeover ? 'overwrite' : 'create',
      ...(takeover ? { expectedHash: bind('staleHash') } : {}),
      docType: 'json',
      mimeType: 'application/json',
      indexing: 'disabled',
      summary: 'The Local PR Shepherd is acting on this branch.',
      content: {
        inlineJson: {
          runId: bind('runId'),
          takenAtMs: bind('takenAtMs'),
          pullNumber: bind('number'),
          headSha: bind('headSha'),
          checkRunId: bind('checkRunId'),
          // Read back by the rules: a merge pass paused holds its lease past the bound.
          decision: bind('decision'),
        },
      },
    },
    outputProjection: {
      path: { path: 'path', onMissing: 'error' as const },
      lease: { fromInput: 'content' },
      // What the lease holds as this pass wrote it: `release` deletes only that.
      contentHash: { path: 'contentHash', onMissing: 'error' as const },
    },
  };
}

/** The lease as it stands before the rules: the branch's lease, and the run that holds it. */
export const LEASE_READ_TASKS = [
  {
    taskId: 'read-in-flight-lease',
    name: "Read the branch's lease",
    goal: "Read the lease on the pull request's branch in the space's memory, where there is one — the run that took it and when — taken for the length of a fix and released at its end.",
    type: 'operation' as const,
    operation: 'memory.store.get',
    when: OURS,
    // No lease is the usual case. The read only advises: the lease is
    // taken by a write that fails where another holds it.
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: { ...REPOSITORY, ...HEAD_REF },
    context: ctx('memory.store.get'),
    inputTemplate: { target: { path: LEASE_PATH }, view: 'content' },
  },

  {
    taskId: 'read-lease-owner',
    name: "Read the lease's run",
    goal: 'Read the run that holds the lease: a lease whose run has ended, or that cannot be read, is stale.',
    type: 'operation' as const,
    operation: 'workflow.run.detail',
    when: {
      expression: 'tasks.read-in-flight-lease.output.dataJson.runId != null',
      onMissingRef: SKIP,
    },
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: { runId: out('read-in-flight-lease', 'dataJson.runId') },
    context: ctx('workflow.run.detail'),
    inputTemplate: { runId: bind('runId'), compact: true },
  },
];

export const RELEASE_TASK = {
  taskId: 'release',
  name: 'Release the lease',
  goal: "Delete the branch's lease once everything this pass started has ended, whichever way it ended — only while it is still this pass's own, as it wrote it. A lease another run has since taken over is that run's, and is left.",
  type: 'operation' as const,
  operation: 'memory.store.delete',
  dependsOn: LEASED_WORK,
  when: LEASE_HELD,
  // A lease taken over refuses the delete; the pass still records.
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    ...leaseBindings('leasePath', 'path'),
    ...leaseBindings('leaseHash', 'contentHash'),
  },
  context: ctx('memory.store.delete'),
  inputTemplate: {
    target: { path: leaseValue('leasePath') },
    // The content this pass wrote — its run and the time it took it.
    expectedHash: leaseValue('leaseHash'),
  },
};
