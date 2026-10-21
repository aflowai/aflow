import {
  SHEPHERD_ABANDON_DOCS,
  SHEPHERD_HANDOFF_PINS,
  SHEPHERD_HANDS_OFF_LABEL,
  SHEPHERD_LEASE_ROOT,
} from '@aflow/schemas';
import { HANDOFF_WRITE_TASKS } from './localPrShepherdHandoff.js';
import { SHEPHERD_BUDGET_SPENT } from './localPrShepherdRules.js';
import { bind, ctx, NUMBER, out, REPOSITORY, SKIP } from './localPrShepherdWiring.js';

/**
 * The hand-over of the Local PR Shepherd (Plan 321 D4): where the attempt
 * budget is spent, the pass's handoff comment says why it stopped, and one
 * Action Center item asks a person to take the pull request — one per head,
 * however many passes find the budget spent on it.
 */

/**
 * `shepherd/<owner>/<repo>/pulls/<number>/abandons/<headSha>.json`, bound from
 * `owner`, `repo`, `number` and `headSha`.
 */
const ABANDON_CLAIM_PATH = {
  $concat: [
    `${SHEPHERD_LEASE_ROOT}/`,
    bind('owner'),
    '/',
    bind('repo'),
    `/${SHEPHERD_HANDOFF_PINS}/`,
    { $text: [bind('number')] },
    `/${SHEPHERD_ABANDON_DOCS}/`,
    bind('headSha'),
    '.json',
  ],
};

const DECIDED_ABANDON = `tasks.decide.output.decision == '${SHEPHERD_BUDGET_SPENT}'`;

export const ABANDON_TASKS = [
  {
    taskId: 'claim-abandon',
    name: 'Claim the hand-over of this head',
    goal: 'Once the handoff comment says why the shepherd stopped, record that this head of the pull request has been handed to a person — created only where nothing is recorded for it, so one Action Center item is raised for a head, however many passes find its budget spent and however they overlap.',
    type: 'operation' as const,
    operation: 'memory.store.put',
    // After the comment: the item follows the record a person reads first.
    dependsOn: HANDOFF_WRITE_TASKS.map((task) => task.taskId),
    when: { expression: DECIDED_ABANDON, onMissingRef: SKIP },
    // Refused where the head is claimed already — the usual case after the
    // first pass — or where the store could not answer; the pass still ends.
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      ...REPOSITORY,
      ...NUMBER,
      headSha: out('read-pr', 'data.headSha'),
      checkRunId: out('read-pr-checks', 'data.firstFailing.id'),
      runId: { kind: 'run_id' as const },
      handedOverAtMs: { kind: 'clock' as const },
    },
    context: ctx('memory.store.put'),
    inputTemplate: {
      path: ABANDON_CLAIM_PATH,
      writeMode: 'create',
      docType: 'json',
      mimeType: 'application/json',
      indexing: 'disabled',
      summary: 'The Local PR Shepherd handed this head of the pull request to a person.',
      content: {
        inlineJson: {
          headSha: bind('headSha'),
          checkRunId: bind('checkRunId'),
          runId: bind('runId'),
          handedOverAtMs: bind('handedOverAtMs'),
        },
      },
    },
  },

  {
    taskId: 'hand-over',
    name: 'The shepherd stopped on a pull request',
    goal: 'Ask a person to take over the pull request the shepherd stopped on — one Action Center item for its head. It approves nothing and changes nothing: whatever the person writes closes the item and ends the pass.',
    type: 'human' as const,
    intent: 'collect' as const,
    failureMode: 'isolate' as const,
    dependsOn: ['claim-abandon'],
    when: {
      allOf: [DECIDED_ABANDON, "tasks.claim-abandon.status == 'succeeded'"],
      onMissingRef: SKIP,
    },
    pauseInstruction: `The Local PR Shepherd stopped on one of the loop's pull requests: CI failed on it again after the shepherd had acted on as many failures as its attempt budget allows. Its handoff comment on the pull request — the run's "Read the pull request" task names which — says which check run it last acted on and what each round did. It acts on this head no more: fix the branch yourself, push to it to have the shepherd read the new head, or label the pull request \`${SHEPHERD_HANDS_OFF_LABEL}\` to have it left alone. Submitting this closes the item and changes nothing else.`,
    outputContract: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          note: {
            type: 'string',
            maxLength: 2000,
            description:
              'What you will do with the pull request, for the run’s record. No rule reads it.',
          },
        },
      },
    },
  },
];
