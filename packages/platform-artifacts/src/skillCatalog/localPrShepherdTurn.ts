import { SHEPHERD_LEASE_ROOT, SHEPHERD_TURN_DOCUMENT } from '@aflow/schemas';
import { DECIDED_UNLISTED_FIRST } from './localPrShepherdRules.js';
import { bind, ctx, NUMBER, out, REPOSITORY, SKIP } from './localPrShepherdWiring.js';

/**
 * Turns over the loop's pull requests (Plan 321 P2): a pass aimed at none
 * tends one, so passes on a schedule tend the one after the last one tended.
 * Ordered by GitHub's `updated_at` instead, the pull request a pass had just
 * written its handoff on could stay first, and every other wait behind it.
 * The turn only advises: a pass that cannot read it tends the newest, and two
 * passes that read the same turn meet at the branch's lease.
 *
 * It also notes when GitHub first refused to list the pull requests, so the
 * rules hand a repository over only once the refusal has lasted
 * (`SHEPHERD_UNLISTED_PERSISTS_AFTER_MS`): a pass that lists them records the
 * turn without the note, and a refusal after it is a new first one.
 */

/** `shepherd/<owner>/<repo>/turn.json`, bound from `owner` and `repo`. */
const TURN_PATH = {
  $concat: [
    `${SHEPHERD_LEASE_ROOT}/`,
    bind('owner'),
    '/',
    bind('repo'),
    `/${SHEPHERD_TURN_DOCUMENT}`,
  ],
};

const DISCOVERING = "tasks.aim.output.decision == 'discover'";

/** The pull request the last pass aimed at none tended, for `list-prs`' argument. */
export const LAST_TENDED = out('read-turn', 'dataJson.pullNumber');

export const READ_TURN_TASK = {
  taskId: 'read-turn',
  name: 'Read whose turn it is',
  goal: "With the pass aimed at none, read which of the loop's pull requests the last such pass tended, so this one tends the next.",
  type: 'operation' as const,
  operation: 'memory.store.get',
  when: { expression: DISCOVERING, onMissingRef: SKIP },
  // No turn is the first pass's; one that cannot be read leaves the list
  // newest first, which only delays a turn.
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: { ...REPOSITORY },
  context: ctx('memory.store.get'),
  inputTemplate: { target: { path: TURN_PATH }, view: 'content', ifMissing: 'absent' },
};

export const REMEMBER_TURN_TASK = {
  taskId: 'remember-turn',
  name: 'Record whose turn it was',
  goal: 'With the pass aimed at none and the pull requests listed, record the pull request it tends — the one the last such pass tended, where it read none — and the run that listed them, so the next such pass tends the one after it, and no earlier refusal to list them is noted any longer. A pass aimed at one pull request takes no turn and records none.',
  type: 'operation' as const,
  operation: 'memory.store.put',
  when: {
    allOf: [DISCOVERING, 'tasks.list-prs.output.statusCode == 200'],
    onMissingRef: SKIP,
  },
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 2,
  inputBindings: {
    ...REPOSITORY,
    ...NUMBER,
    lastTended: LAST_TENDED,
    runId: { kind: 'run_id' as const },
  },
  context: ctx('memory.store.put'),
  inputTemplate: {
    path: TURN_PATH,
    writeMode: 'upsert',
    docType: 'json',
    mimeType: 'application/json',
    indexing: 'disabled',
    summary: "The pull request the Local PR Shepherd's last pass over this repository tended.",
    // The run makes each turn's content its own: a repository's hand-over is
    // keyed by the turn's hash, so a pass that lists the pull requests ends
    // the case its listing was handed over as, even on the same turn again.
    content: {
      inlineJson: {
        pullNumber: { $firstOf: [bind('number'), bind('lastTended')] },
        runId: bind('runId'),
      },
    },
  },
};

export const NOTE_UNLISTED_TASK = {
  taskId: 'note-unlisted',
  name: 'Note when the pull requests could first not be listed',
  goal: "Where GitHub refused to list the repository's open pull requests and no earlier refusal is noted since they were last listed, note on the turn when this one was, keeping whose turn it is — so a later pass hands the repository to the Helmsman only once the refusal has lasted.",
  type: 'operation' as const,
  operation: 'memory.store.put',
  // A turn that could not be read is not overwritten: what it holds is unknown.
  when: {
    allOf: [DECIDED_UNLISTED_FIRST, "tasks.read-turn.status == 'succeeded'"],
    onMissingRef: SKIP,
  },
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 2,
  inputBindings: {
    ...REPOSITORY,
    lastTended: LAST_TENDED,
    runId: { kind: 'run_id' as const },
    unlistedAtMs: { kind: 'clock' as const },
  },
  context: ctx('memory.store.put'),
  inputTemplate: {
    path: TURN_PATH,
    writeMode: 'upsert',
    docType: 'json',
    mimeType: 'application/json',
    indexing: 'disabled',
    summary:
      "The pull request the Local PR Shepherd's last pass over this repository tended, and when GitHub first refused to list them since.",
    content: {
      inlineJson: {
        pullNumber: bind('lastTended'),
        runId: bind('runId'),
        unlistedAtMs: bind('unlistedAtMs'),
      },
    },
  },
};
