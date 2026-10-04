# Plan 322 — Plans are platform records

**Status:** 📋 planned — nothing built; start at P0

**Builds on:** Plan 315 (the loop and the stream protocol that drives it), the campaign engine (`packages/cybernetic-runtime/src/campaigns.ts`), the attention block the Helmsman reads each turn (`packages/cybernetic-runtime/src/attentionBuilder.ts`), the `workflow.campaign.*` inline-op family as the template for an operation family with one authority for the agent path and the operator path, and the vocabulary Plan 299 §3.4 fixed for a tree of intentions. It takes from 299 only the tree, and builds it standalone for the on-demand Helmsman.

## 1. Problem

The plan that drives a stream of work lives in a markdown file in the repository, and every stream writes that one file: its decisions, its delivery notes, its findings. In one day `main` moved under a pull request three times with no content in the conflict, each costing a merge round of the loop (F114). A Helmsman conversation starts cold: it reads a protocol document to learn what the stream is, and every slice begins with a hand-written brief that restates where the work stands (F103, F107). The shepherd (Plan 321) needs "what is happening to this branch right now" and plans to assemble it from a pull-request comment and a memory-store lease, because nothing on the platform holds it. Three consumers want the same record, and none has it.

What exists is adjacent and not it. A campaign is one goal with one metric for one skill (`campaigns`, `packages/database/src/schema/tenant/campaigns.ts`). A learning is keyed by skill or campaign and cannot point at an arbitrary record (`coach_learnings`, `CoachLearningScopeSchema`). The memory store holds untyped documents under paths, with no join to the runs that did the work. A workflow run carries a `campaign_id` and a `metadata` bag, and no purpose. The attention block the Helmsman reads each turn knows the active runs and the pending proposals, and nothing about why they run.

The earlier plans in this area (88, 99, 215, 234, 299) were design exercises; part of each was built, part was not, and none was driven to a measurable end through the Helmsman. The stream that produced this plan was: forty findings and ten slices landed by briefing the Helmsman, reading reviews and iterating. This plan is sized to that method. The goal is fixed; the design below changes wherever use shows it should.

## 2. Decisions

**D1 — A plan is a tree of nodes in Postgres, per space.** `plan_nodes` carries parent, kind, title, goal, success criteria, status, a bounded working note, and a revision counter; `plan_node_links` carries typed references from a node to the runs, sessions, pull requests, documents and findings that touched it. _Rejected:_ a memory-store document — untyped, path-addressed, no join to runs, and a second session's write can lose the first's; a markdown file — the problem. Columns over a JSON bag, because the Helmsman, the attention block and the operator surface all read the same fields and a query on status or parent is the common case.

**D2 — A node's kind is a mode of work, not a classification, and the vocabulary is Plan 299's.** `execute | investigate | decide`; status `active | waiting | blocked | done | dropped`; success criteria may be provisional and are revised with the reason in the note. Breakdown is recursive by adding children; a node with children is done when the Helmsman marks it done against its criteria, never automatically from its children, because the criteria are the parent's and the children are one attempt at them. _Rejected:_ dependency edges, wake conditions, commitment policies and budgets in P0 — each is a 299 element with a reason, and none is needed to replace the markdown file; dependencies arrive in P2 when the shepherd reads the tree.

**D3 — The operations are Helmsman tools, `plan.node.*`, never a skill, and never a Runner's.** `create`, `update`, `get`, `list`, `link`. Planning is open-ended; a skill's worth is a validatable procedure (Plan 190), and the eval plane's rule holds here: a run may serve a node and may never rewrite the plan it serves. The step type is `plan`, group `node`, so the operation reads as what it is; the capability group is added to the system profiles in the same migration. _Rejected:_ `workflow.plan.*` to save the routing line — a plan is not a workflow, and the agent reads operation names as ontology.

**D4 — The active tree is in the attention block, and a fresh session reads it before anything else.** `HelmsmanAttention` gains the space's active nodes: title, kind, status, the note's first line, and the in-flight runs under each. The space context's cached block stays as it is. _Rejected:_ a `SpaceContext` section — the tree changes with every turn of work and the cached block is invalidated per step type, where the attention block is rebuilt per turn by design.

**D5 — A run carries the node it serves.** `workflow.run.start` takes an optional `planNodeId`, stored as `workflow_runs.plan_node_id` with an index, so the attention block renders runs under their nodes and the node's links are derived, not maintained by hand. A publication or commission started for a node links its pull request and its result to the node when it ends. _Rejected:_ `metadata.planNodeId` — a zero-migration link that nothing can index or join.

**D6 — Writes are compare-and-set on the node's revision.** Two sessions in one space may work the same tree; `update` carries `expectedRevision` and a stale write is refused with the current node, the way `memory.store.put` refuses on `expectedHash`. _Rejected:_ a revision log per write in P0 — the refusal is what prevents loss; the history of a node is its links and its note, and a log is added only if reconciliation across sessions turns out to need it.

**D7 — The operator reads the same authority.** `GET /v1/spaces/:spaceId/plan` returns the tree from the same engine functions the inline ops call, as the campaign routes do. The operator surface that renders it is P3; the stream is driven from the Helmsman and the Workbench until then.

**D8 — Campaigns and learnings are left where they are until the record has carried a slice.** A node may link to a campaign; whether a campaign becomes a node kind is decided after P1 with evidence. A learning gains `scope: plan` with a node id in P2, when the record exists to attach to. _Rejected:_ redesigning either now.

## 3. Design

### 3.1 Records

`plan_nodes` (per space): `id`, `space_id`, `parent_id`, `kind`, `title`, `goal`, `criteria`, `status`, `note`, `revision`, `position`, `created_by`, `created_at`, `updated_at`, `closed_at`. `plan_node_links`: `node_id`, `kind` (`run | session | pull_request | document | finding | campaign`), `ref`, `label`, `created_at`. `workflow_runs.plan_node_id`. Zod in `packages/schemas/src/cybernetic/plan.ts`; the length caps on `goal`, `criteria` and `note` are storage ceilings in the thousands, since they hold model-authored prose a person reads.

### 3.2 Operations

| Operation          | Does                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `plan.node.create` | a node under a parent (or a root), with kind, title, goal, criteria                          |
| `plan.node.update` | status, note, criteria, title, parent, position — compare-and-set on `expectedRevision`      |
| `plan.node.get`    | one node with its children, links and in-flight runs                                         |
| `plan.node.list`   | the space's tree, filtered by status or root, bounded                                        |
| `plan.node.link`   | a typed reference from a node to a run, session, pull request, document, finding or campaign |

Engine functions in `packages/cybernetic-runtime/src/plan/`, called by the inline handlers under `handlers/inlineOps/plan/` and by the REST route. Registered in `packages/schemas/src/catalog/registry.ts` with `usage.whenToUse` and `pitfalls` carrying the rules (a node is done against its criteria; update before you brief; link what you start), pinned for the Helmsman in `catalog.coreOperations`, excluded from every Runner grant tier by a guard test.

### 3.3 What a fresh session sees

The attention block renders, for each active root: `[execute] 315 · Local first-run ergonomics — active — next: F114 findings out of the plan file` with its active children indented, and under each the in-flight runs by slug and status. The Helmsman's first move in a stream is `plan.node.get` on the node named, and its briefs are the node's goal and criteria plus what the operator adds.

## 4. What it affects

- `packages/database` — migration 218: `plan_nodes`, `plan_node_links`, `workflow_runs.plan_node_id`; the capability group on the system profiles (`tenant.ts`); `DIRECT_SPACE_ID_TABLES` in `spaceCascade.ts`.
- `packages/schemas` — `cybernetic/plan.ts`, `operations/plan/`, the registry, `runStart.ts` (`planNodeId`), `AttentionItemKind` unchanged.
- `packages/cybernetic-runtime` — `plan/` engine, `attentionBuilder.ts` section and render branch.
- `apps/aflow-orchestrator` — `inlineOperations.ts` prefix, `dispatchInlineOp.ts` route, `handlers/inlineOps/plan/`.
- `packages/platform-artifacts` — `cyberneticAgents.ts` core operations; a guard test beside `helmsmanEvalPlanePreset.test.ts`.
- `packages/server-runtime` — `routes/plan.ts` (GET).
- `docs/dev/driving-work-through-the-loop.md` — a round starts from the node, and findings are nodes.

## 5. Phases

**P0 — The record, the tools, the block.** Everything in §3 except `planNodeId` on runs. _Exit:_ in Full Circle, a Helmsman conversation that is told only "continue the Plan 315 stream" names the active node and its next step from the attention block alone and starts the right commission, with no hand-written brief; a second conversation's stale `update` is refused and loses nothing.

**P1 — Work flows through the node.** `planNodeId` on `workflow.run.start`; commissions and publications started for a node link their pull request and result; Plan 315's remaining items are the first tree, and its findings become nodes of kind `investigate` so the markdown table stops growing. _Exit:_ one whole slice — brief, commission, review, publish, merge — runs with every record on the node and the plan document untouched.

**P2 — Learnings and dependencies.** `coach_learnings` gains `scope: plan`; dependency edges with a condition on the dependency's outcome, validated for cycles; the shepherd (Plan 321) reads a branch's node instead of a pull-request comment. _Exit:_ a learning written on a node is read by the next session that opens it; Plan 321 P1 is implemented against nodes.

**P3 — Seen by the operator.** The tree in the space, a `decide` node raising an Action Center item, done nodes with their evidence. _Exit:_ the operator marks a node done or drops a branch without the Helmsman.

Deferred, not planned here: budgets and metabolism (299 §3.9), commitment policies and wake conditions, a revision log, campaigns as a node kind, importing the earlier plan archive. Only the work a stream picks up becomes nodes.

## 6. How it is proven

- **A cold session continues**: the P0 exit, measured twice with different conversations.
- **No lost update**: two sessions update one node; the second is refused with the first's revision.
- **A Runner cannot plan**: the guard test fails when any grant tier admits `plan.*`.
- **Deleted with its space**: the cascade contract test covers both tables.
- **Nothing in the file**: after P1, the plan document's findings table has no new rows and the slice's record is complete on its node.

## 7. Open questions

- Whether a campaign becomes a node of kind `execute` with a metric criterion, or stays a parallel record a node links to; decided after P1 with the Kaggle skill as the case.
- Whether `done` on a parent should require every child terminal, or only the criteria; P0 says criteria alone and the dogfood will show which the Helmsman gets wrong.
- Where the operator's `decide` answer is recorded — on the node's note, or as a link to the Action Center item.
