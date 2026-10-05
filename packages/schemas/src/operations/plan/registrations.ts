import type { OperationRegistration } from '../../catalog/operationCatalog.js';
import {
  PlanNodeCreateInputSchema,
  PlanNodeCreateOutputSchema,
  PlanNodeGetInputSchema,
  PlanNodeGetOutputSchema,
  PlanNodeLinkInputSchema,
  PlanNodeLinkOutputSchema,
  PlanNodeListInputSchema,
  PlanNodeListOutputSchema,
  PlanNodeUpdateInputSchema,
  PlanNodeUpdateOutputSchema,
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
      oneLine: 'Move a node on: status, note, criteria — compare-and-set on its revision.',
      whenToUse: [
        'A round ends: record where the node stands and what comes next in the note',
        'The node’s criteria are met (done, with the outcome) or it is let go (dropped)',
      ],
      whenNotToUse: ['Adding a step under a node — use plan.node.create with parentId'],
      pitfalls: [],
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
      'Open a plan node: goal, criteria, status, note, outcome and revision, with its children in order, what is linked to it, and the runs in flight for it and the nodes under it.',
    tags: ['plan', 'node', 'read'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine:
        'Open a plan node with its goal, criteria, note, children, links and runs in flight.',
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
      pitfalls: [],
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
];
