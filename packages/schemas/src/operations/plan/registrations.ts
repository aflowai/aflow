import type { OperationRegistration } from '../../catalog/operationCatalog.js';
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
  PLAN_STREAM_ATTEMPTS_DEFAULT,
} from './schemas.js';

const EXAMPLE_NODE_ID = '00000000-0000-0000-0000-000000000000';

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
      ],
      minimalExampleInput: {
        kind: 'execute',
        title: 'Local first-run ergonomics',
        goal: 'A new operator reaches a working space without help.',
        criteria: 'yarn start on a clean machine ends with the web app serving a space.',
      },
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
      ],
      minimalExampleInput: {
        nodeId: EXAMPLE_NODE_ID,
        expectedRevision: 1,
        note: 'next: F114 findings out of the plan file',
      },
    },
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
        'Before briefing a round of work on a node — the attention block shows only its title and the note’s first line',
        'A stream continues in a new conversation: open the node it names — its runs in flight are the work under way for it',
      ],
      whenNotToUse: [
        'Finding a node — the attention block lists the open tree; plan.node.list filters it',
      ],
      pitfalls: [
        'A round’s brief is the node’s goal and criteria, with what the operator adds — not a restatement from the conversation',
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
      whenToUse: [
        'Work for a node was done outside a run started with its planNodeId — a pull request opened by hand, a document written, a finding named',
      ],
      whenNotToUse: [
        'A run started with planNodeId — it links itself and its pull request when it ends',
      ],
      pitfalls: [
        'A record is linked to a node once; linking it again is refused, and plan.node.get lists what is linked',
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
    name: 'Next in Plan Stream',
    actionLabel: 'Reading where the stream stands…',
    semanticDescription:
      'Decide what a stream does now, by rule, from its records: walk from its root to the active node, read that node’s runs, links, attention items and pull request, and answer record_merge, wait, stop or continue — read_pull_request first where the answer turns on GitHub. Writes nothing and starts nothing.',
    tags: ['plan', 'node', 'stream', 'schedule'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'A stream’s next move — wait, stop or continue — decided from its records.',
      whenToUse: [
        'A message tells you to continue a plan stream by calling plan.node.next — a scheduled firing: call it before anything else and do only what its decision says',
        `Making a stream continue itself on a schedule: agent.schedule.create with action "start_run", target {"kind":"platform-role","systemRole":"cybernetic-helmsman"}, the operator’s cron, and input.input the message "Continue the plan stream <rootNodeId>: call plan.node.next with {"rootNodeId":"<rootNodeId>","attempts":${String(PLAN_STREAM_ATTEMPTS_DEFAULT)}} and act on its decision." — the interval and the stream are the operator’s to name`,
      ],
      whenNotToUse: [
        'A conversation the operator is driving — plan.node.get on the node, and the operator decides',
      ],
      pitfalls: [
        'read_pull_request: read it through the space’s GitHub binding, then call again with the same rootNodeId and attempts and `pullRequest` copied from the answer — `read: "failed"` where the read failed. Never fill it in from memory',
        'record_merge: judge the node against its criteria with the merged change in hand. Met: plan.node.update status "done", outcome naming the pull request and its merge commit. Not met: leave it active, the note’s first line beginning with noteHead and naming the next step. Then pass `link` to plan.node.link — the merge counts as judged only once it is linked — and call plan.node.next again. A PLAN_NODE_STALE refusal means someone wrote first: end the firing as wait, writing nothing more; PLAN_NODE_UNCHANGED means the note was written by an earlier firing: link it',
        'wait: start nothing, cancel nothing, write nothing, and end — `claimed` means another firing decided continue on the same state and is commissioning it',
        'stop: pass `update` to plan.node.update as it stands; start nothing and cancel nothing',
        'continue: brief the commission from the node’s goal and criteria — and, on `retry`, from that run’s failure or the review run’s findings — and start it with the node’s id as planNodeId; its publication takes the same planNodeId',
      ],
      minimalExampleInput: { rootNodeId: EXAMPLE_NODE_ID, attempts: PLAN_STREAM_ATTEMPTS_DEFAULT },
    },
    accessMode: 'read',
    inputZod: PlanNodeNextInputSchema,
    outputZod: PlanNodeNextOutputSchema,
  },
];
