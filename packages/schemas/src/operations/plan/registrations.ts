import type { OperationRegistration } from '../../catalog/operationCatalog.js';
import {
  PLAN_NODE_CARD_UPDATE_DESCRIPTION,
  PLAN_NODE_CARD_WRITE_DESCRIPTION,
  PlanNodeCardSchema,
} from '../../cybernetic/plan.js';
import { toJsonSchemaSync } from '../../utils/jsonSchema.js';
import {
  PlanNodeCreateInputSchema,
  PlanNodeCreateOutputSchema,
  PlanNodeDependInputSchema,
  PlanNodeDependOutputSchema,
  PlanNodeGetInputSchema,
  PlanNodeLearnInputSchema,
  PlanNodeLearnOutputSchema,
  PlanNodeGetOutputSchema,
  PlanNodeLinkInputSchema,
  PlanNodeLinkOutputSchema,
  PlanNodeListInputSchema,
  PlanNodeListOutputSchema,
  PlanNodeNextInputSchema,
  PlanNodeNextOutputSchema,
  PlanNodeUpdateInputSchema,
  PlanNodeUpdateOutputSchema,
  PLAN_RESIDENT_SCHEDULE_CRON,
} from './schemas.js';

const EXAMPLE_NODE_ID = '00000000-0000-0000-0000-000000000000';

interface CardJsonSchema {
  type?: string;
  properties?: Record<string, CardJsonSchema>;
  required?: string[];
  items?: CardJsonSchema;
}

/** A JSON Schema as a one-line signature: `{key: string, key?: string}[]`. */
function signature(schema: CardJsonSchema): string {
  if (schema.type === 'array' && schema.items) return `${signature(schema.items)}[]`;
  if (schema.type === 'object' && schema.properties) {
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties).map(
      ([key, value]) => `${key}${required.has(key) ? '' : '?'}: ${signature(value)}`,
    );
    return `{${fields.join(', ')}}`;
  }
  return schema.type ?? 'unknown';
}

/**
 * The card as a turn's tool declaration carries it (Plan 337 D1): a described
 * object whose description holds the shape, derived from `PlanNodeCardSchema`.
 * Every turn pays for the declaration, and the card's full JSON Schema costs
 * over 300 tokens an operation for a field few turns write. Dispatch validates
 * against the full schema, whose refusals name the section and the ceiling.
 */
function cardForAgents(lead: string): string {
  const shape = signature(toJsonSchemaSync(PlanNodeCardSchema) as CardJsonSchema);
  return `${lead} Shape: ${shape}`;
}

/**
 * Plan 322 D3 — the Helmsman's own tools, never a skill's: a run may serve a
 * node and may never rewrite the plan it serves (`isPlanOperation`).
 */
export const PlanOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'plan',
    group: 'node',
    verb: 'create',
    name: 'Create Plan Node',
    actionLabel: 'Adding to the plan…',
    groupDisplayName: 'Plan',
    groupDescription:
      'The space’s plan: a tree of nodes, each with a goal and the criteria it is done against.',
    semanticDescription:
      'Add a node to the space’s plan, under a parent or as a root, with the goal it serves and the criteria it is done against. Every session in the space sees it from its next turn.',
    tags: ['plan', 'node', 'create'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Add a node to the space’s plan, with its goal and criteria.',
      whenToUse: [
        'A stream of work starts that is not in the plan yet',
        'A node is broken down into the steps that will meet its criteria',
      ],
      whenNotToUse: ['Changing a node that exists — use plan.node.update'],
      pitfalls: [
        'Write criteria a later session can check without this conversation — a round’s brief is the node’s goal and criteria',
        'A node that asks the operator for a decision carries a `card`, a proposal too: one or two short sentences an item, every question with the answer you recommend. Done when is the criteria, so the card does not repeat it',
        'A plan document is commissioned with the card as its first section: write that same card on the node, unchanged',
      ],
      minimalExampleInput: {
        kind: 'execute',
        title: 'Local first-run ergonomics',
        goal: 'A new operator reaches a working space without help.',
        criteria: 'yarn start on a clean machine ends with the web app serving a space.',
      },
    },
    agentCollapsedFields: {
      card: cardForAgents(
        `${String(PlanNodeCardSchema.description)} ${PLAN_NODE_CARD_WRITE_DESCRIPTION}`,
      ),
    },
    accessMode: 'write',
    inputZod: PlanNodeCreateInputSchema,
    outputZod: PlanNodeCreateOutputSchema,
  },
  {
    stepType: 'plan',
    group: 'node',
    verb: 'update',
    name: 'Update Plan Node',
    actionLabel: 'Updating the plan…',
    semanticDescription:
      'Change a node against the revision it was read at; a node written since is refused with its current revision, so nothing is lost. A node is done when its own criteria are met, never because its children are.',
    tags: ['plan', 'node', 'update'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine:
        'Move a node on: status, note, goal, criteria, title — compare-and-set on its revision.',
      whenToUse: [
        'A round ends: record where the node stands and what comes next in the note',
        'The node’s criteria are met (done, with the outcome) or it is let go (dropped)',
        'The node’s goal or criteria no longer say what it is for — correct them here',
      ],
      whenNotToUse: ['Adding a step under a node — use plan.node.create with parentId'],
      pitfalls: [
        'An amended goal belongs in `goal`, not the note — every session is briefed from the goal',
        'A note whose first line begins `Revise: ` is the operator sending a blocked proposal back: rewrite goal, criteria and any card from it, keep status blocked, and replace that line with one beginning `Revised: ` that says what changed',
        'The operator asks for a card on an open node they want to decide: write it here, whole, against the node’s revision',
      ],
      minimalExampleInput: {
        nodeId: EXAMPLE_NODE_ID,
        expectedRevision: 1,
        note: 'next: F114 findings out of the plan file',
      },
    },
    agentCollapsedFields: { card: cardForAgents(PLAN_NODE_CARD_UPDATE_DESCRIPTION) },
    accessMode: 'write',
    inputZod: PlanNodeUpdateInputSchema,
    outputZod: PlanNodeUpdateOutputSchema,
  },
  {
    stepType: 'plan',
    group: 'node',
    verb: 'get',
    name: 'Get Plan Node',
    actionLabel: 'Opening the plan node…',
    semanticDescription:
      'Open a plan node: goal, criteria, status, note, outcome and revision, with its children in order, what is linked to it, the runs in flight for it and the nodes under it, what it waits on and what waits on it, and what earlier sessions learned on it and the nodes above it.',
    tags: ['plan', 'node', 'read'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine:
        'Open a plan node with its goal, criteria, note, children, links, runs in flight, dependencies and learnings.',
      whenToUse: [
        'Before briefing a round on a node — the attention block shows only its title and first note line',
        'A stream continues in a new conversation: open the node it names — its runs in flight are the work under way for it',
      ],
      whenNotToUse: [
        'Finding a node — the attention block lists the open tree; plan.node.list filters it',
      ],
      pitfalls: [
        'A round’s brief is the node’s goal and criteria, with what the operator adds — not a restatement from the conversation',
        'A note whose first line begins `Approved: ` or `Revise: ` holds the operator’s instructions: the brief opens with that line, word for word',
      ],
      minimalExampleInput: { nodeId: EXAMPLE_NODE_ID },
    },
    accessMode: 'read',
    inputZod: PlanNodeGetInputSchema,
    outputZod: PlanNodeGetOutputSchema,
  },
  {
    stepType: 'plan',
    group: 'node',
    verb: 'list',
    name: 'List Plan Nodes',
    actionLabel: 'Reading the plan…',
    semanticDescription:
      'List the space’s plan nodes, parents first, by status (open by default) or under one node. Bounded.',
    tags: ['plan', 'node', 'list'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'List plan nodes by status or under one root.',
      whenToUse: ['Looking past what the attention block shows: closed nodes, or a deep subtree'],
      whenNotToUse: ['Reading one node in full — use plan.node.get'],
      pitfalls: [
        'A result with `truncated` is one page: count nodes from `truncated.matched`, never from the page, and read the next page by listing again with `truncated.next.cursor`',
        'A cursor refused as stale means the plan changed between pages; list again without `cursor` rather than retrying it',
        'Under `truncated.bound` `depth` or `nodes`, the last page still leaves nodes unread: reach them with `rootId` nearer them',
      ],
      minimalExampleInput: { status: ['done'] },
    },
    accessMode: 'read',
    inputZod: PlanNodeListInputSchema,
    outputZod: PlanNodeListOutputSchema,
  },
  {
    stepType: 'plan',
    group: 'node',
    verb: 'link',
    name: 'Link to Plan Node',
    actionLabel: 'Linking to the plan…',
    semanticDescription:
      'Record on a plan node a typed reference to what did or holds its work: a run, a session, a pull request, a document, a finding or a campaign. A run started with the node’s planNodeId links itself, and its pull request, when it ends.',
    tags: ['plan', 'node', 'link'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Link a run, session, pull request, document, finding or campaign to a plan node.',
      whenToUse: ['Work for a node was done outside a run started with its planNodeId'],
      whenNotToUse: [
        'A run started with planNodeId — it links itself and its pull request when it ends',
      ],
      pitfalls: [
        'A record is linked to a node once; linking it again is refused, and plan.node.get lists what is linked',
        'A plan document’s pull request merges: link the document to its node, kind "document", ref the file’s URL at the merge sha. A folder with no remote gets the path and the sha as the ref. The node keeps its pull_request link until then',
      ],
      minimalExampleInput: {
        nodeId: EXAMPLE_NODE_ID,
        kind: 'pull_request',
        ref: 'https://github.com/aflowai/aflow/pull/80',
      },
    },
    accessMode: 'write',
    inputZod: PlanNodeLinkInputSchema,
    outputZod: PlanNodeLinkOutputSchema,
  },
  {
    stepType: 'plan',
    group: 'node',
    verb: 'learn',
    name: 'Record a Learning on a Plan Node',
    actionLabel: 'Recording what the plan learned…',
    semanticDescription:
      'Record on a plan node what working it taught — a heuristic, a constraint, an observation or a parameter range, with the runs it was learned from. Every later session that opens the node, or a node under it, reads it in plan.node.get.',
    tags: ['plan', 'node', 'learning'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Record what working a node taught, for the next session that opens it.',
      whenToUse: [
        'A round of a node failed or surprised you, and the next round should start knowing why',
        'Something true of a whole stream was found — record it on the stream’s root, and every node under it reads it',
      ],
      whenNotToUse: [
        'Where the node stands and its next step — that is the note, through plan.node.update',
        'A claim about a skill rather than this work — that is the Coach’s, from the run’s review',
      ],
      pitfalls: [
        'The statement is read by a session that never saw this conversation: say what to do or avoid, and why',
        'A learning that turned out wrong is replaced, not left: record the corrected one with `supersedes` naming it',
      ],
      minimalExampleInput: {
        nodeId: EXAMPLE_NODE_ID,
        kind: 'constraint',
        statement:
          'The integration suite needs a migrated database: a commission that runs it without one fails on setup, not on the change.',
        evidence: { citations: [{ runId: EXAMPLE_NODE_ID }] },
        confidence: 'medium',
      },
    },
    accessMode: 'write',
    inputZod: PlanNodeLearnInputSchema,
    outputZod: PlanNodeLearnOutputSchema,
  },
  {
    stepType: 'plan',
    group: 'node',
    verb: 'depend',
    name: 'Set a Plan Node Dependency',
    actionLabel: 'Ordering the plan…',
    semanticDescription:
      'Make one plan node wait on another’s outcome — done, dropped, or either — or take that edge away, compare-and-set on the waiting node’s revision. An edge that would close a loop of nodes waiting on each other is refused.',
    tags: ['plan', 'node', 'dependency'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Make a node wait on another’s outcome, or remove that edge.',
      whenToUse: [
        'A step cannot start until another lands — its change builds on the other’s',
        'A step goes ahead only where another approach was dropped',
      ],
      whenNotToUse: [
        'Breaking a node down — children are plan.node.create with parentId; a parent is done against its own criteria, not its children',
      ],
      pitfalls: [
        'Pass the revision of the waiting node (`nodeId`), not of the node it waits on — the write moves that revision on',
        'plan.node.get shows each dependency with `met`; nothing starts or stops a node on its own because of one',
      ],
      minimalExampleInput: {
        nodeId: EXAMPLE_NODE_ID,
        expectedRevision: 1,
        dependsOnId: '00000000-0000-0000-0000-000000000001',
        condition: 'done',
      },
    },
    accessMode: 'write',
    inputZod: PlanNodeDependInputSchema,
    outputZod: PlanNodeDependOutputSchema,
  },
  {
    stepType: 'plan',
    group: 'node',
    verb: 'next',
    name: 'Next in Plan',
    actionLabel: 'Reading where the plan stands…',
    semanticDescription:
      'Decide what the plan does now, by rule, from its records: with no root, every open root in position order — the operator’s priority — each walked to its active node and decided from its runs, links, attention items, spend and pull request, the decisions that are not wait answered finish-first; with a root, that stream alone. Answers record_merge, publish, stop, continue or wait — read_pull_request first where the answer turns on GitHub. Writes nothing and starts nothing.',
    tags: ['plan', 'node', 'stream', 'schedule', 'resident'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine:
        'The plan’s next moves — record, publish, stop, continue or wait — decided from its records.',
      whenToUse: [
        'A message tells you to wake as the space’s resident, or to continue a plan stream, by calling plan.node.next — a scheduled wake: call it before anything else and do only what its decisions say',
        `The space’s resident, created once by the operator: agent.schedule.create with action "start_run", target {"kind":"platform-role","systemRole":"cybernetic-helmsman"}, cron "${PLAN_RESIDENT_SCHEDULE_CRON}" unless the operator names another, and input {"input":"<the wake message>","config":{"scheduleId":{"$schedule":"id"}}} (planResidentScheduleInput) — the config is what marks it the resident, whatever the message says. It renews itself; pausing it pauses the resident`,
      ],
      whenNotToUse: [
        'A conversation the operator is driving — plan.node.get on the node, and the operator decides',
      ],
      pitfalls: [
        'Across the board, act on `decisions` in order and nothing else; empty, end with no reply. Each decision’s `answer` is what one stream answers. A blocked node is the operator’s: nothing commissions it, and a node you create is created blocked',
        'read_pull_request: read it through the space’s GitHub binding, then call again with its root as rootNodeId and `pullRequest` copied from the answer — `read: "failed"` where the read failed. Never fill it in from memory',
        'record_merge: judge criteria against the merge, then close with status "done" and the outcome when criteria are met. After a successful close, link the merge. Otherwise write unmet criteria beginning with noteHead, then link the merge. A refused close raises a wait line and an Action Center item once per revision.',
        'publish: start Local Publish with `commission` as it stands, a branch, the node’s planNodeId and wait "none"; it commits under the commission’s summary. Write nothing to the node, as on continue: the publication serving it is the record',
        'revise: the operator sent a blocked proposal back. Rewrite its goal, criteria and any card from `node.instructions` with plan.node.update, keep status blocked, and start the note with noteHead in place of the `Revise: ` line. Start nothing: the operator approves the rewrite',
        'stop: pass `update` to plan.node.update as it stands; start nothing and cancel nothing',
        'continue: open the brief with `node.instructions` word for word where it is present, then brief the commission from the node’s goal and criteria — on `retry`, from that run’s failure or the review run’s findings — based on origin/<base> (a fix round on its branch), never on the connected folder’s checkout; start it with the node’s planNodeId and wait "none" — that run, serving the node, is the record the next wake reads. Write nothing to the node: a write after the commission starts reads as the node changed since, so the next wake commissions it again instead of publishing what it made',
      ],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: PlanNodeNextInputSchema,
    outputZod: PlanNodeNextOutputSchema,
  },
];
