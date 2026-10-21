import { SHEPHERD_LEASE_ROOT, SHEPHERD_TURN_DOCUMENT } from '@aflow/schemas';
import { bind, ctx, NUMBER, out, REPOSITORY, SKIP } from './localPrShepherdWiring.js';

/**
 * Turns over the loop's pull requests (Plan 321 P2): a pass aimed at none
 * tends one, so passes on a schedule tend the one after the last one tended.
 * Ordered by GitHub's `updated_at` instead, the pull request a pass had just
 * written its handoff on could stay first, and every other wait behind it.
 * The turn only advises: a pass that cannot read it tends the newest, and two
 * passes that read the same turn meet at the branch's lease.
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
  goal: 'With the pass aimed at none, record the pull request it tends, so the next such pass tends the one after it. A pass aimed at one pull request takes no turn and records none.',
  type: 'operation' as const,
  operation: 'memory.store.put',
  when: {
    allOf: [DISCOVERING, 'tasks.read-pr.output.statusCode == 200'],
    onMissingRef: SKIP,
  },
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 2,
  inputBindings: { ...REPOSITORY, ...NUMBER },
  context: ctx('memory.store.put'),
  inputTemplate: {
    path: TURN_PATH,
    writeMode: 'upsert',
    docType: 'json',
    mimeType: 'application/json',
    indexing: 'disabled',
    summary: "The pull request the Local PR Shepherd's last pass over this repository tended.",
    content: { inlineJson: { pullNumber: bind('number') } },
  },
};
