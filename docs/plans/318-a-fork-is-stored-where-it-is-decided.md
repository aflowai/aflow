# Plan 318 — A fork is stored where it is decided: routes on the source task

**Status:** 🔨 P1–P4 built; the live compose and patch runs open · **Builds on:** Plan 316 (the decision step), Plan 317 (agents propose, operators approve)

## 1. Problem

A workflow branches by putting a `when` on each task that may be skipped. The condition lives on the _target_, so one fork — "billing goes here, technical there, anything unclear to an agent" — is stored as several unrelated guards scattered over the tasks it enables. Nothing in the stored workflow says they belong together.

That costs three things.

- **A fork cannot be edited as a fork.** A decision task is authoring vocabulary: assembly expands it into an operation task and hand-shaped guards on its targets, and the decision is gone. Adding one answer to a live triage skill means writing a correct `allOf` guard on a new task, keeping the confidence clause consistent with its siblings and wiring `dependsOn` by hand. Helmsman did it, live, in about eight attempts, succeeding only because each validator named the next mistake.
- **The pieces drift.** Rename a choice option and the guard that reads it still compiles; remove a routed task and nothing notices the branch that no longer goes anywhere. Each guard is checked alone.
- **Branching is not a first-class thing anywhere else.** An API call that should send `status 409` one way and `200` another, an agent score that should gate a retry — each is the same scattered-guard pattern, written by hand.

## 2. Decisions

**D1 — Routes live on the source task, for any task.** A task may declare where its outcome sends the run:

```
routes: [
  { when: "output.answers.team.value == 'billing'",       enable: ["billing_responder"] },
  { when: { anyOf: ["output.answers.team.value == 'unclear'",
                    "output.answers.team.decided == false"] }, enable: ["escalate"] }
]
```

`when` is a predicate over the source task's own output, in the dialect `poll.until` already uses (`output.<path> <op> <literal>`, single or `anyOf` / `allOf`). `enable` names the tasks the route turns on. Nothing about it is decision-specific: an operation, an agent or a human task can route. _Rejected:_ a `decision` field on the workflow task — it would carry a concept that only means something for one operation into every consumer of the workflow format.

**D2 — The target's guard is derived, never stored.** `materializeSkillTasks` — the derivation every run and every validity check already goes through, and the only form ever executed — gives each routed task the `when` its routes imply and adds the source to its `dependsOn`. The stored workflow keeps the routes and nothing else. A routed task may not also declare a `when` of its own. A task is enabled by routes of **one** source; several routes of that source enabling it combine as `anyOf`, and a combination that has no single-level form is refused (the `when` grammar has no nesting and no negation). _Rejected:_ an `otherwise` branch — it needs a negation the grammar does not have, and the decision case covers its need with an explicit route.

**D3 — The decision task lowers to routes.** Compose-skill's `decision` task becomes an `ai.decision.decide` operation task carrying `routes`, built by the same rules Plan 316 uses today (a route on a confident answer adds `decided == true`; a task that is also the fallback drops it). Nothing decision-specific is stored. Checks that only make sense for one operation — a route naming an option its question does not offer, a score threshold outside the rubric — are contributed by that operation through a small route-check registry keyed by operation id, and run alongside the generic checks. _Rejected:_ storing the authored decision draft beside the lowered form — two forms of one definition, which drift.

**D4 — Routes are checked as a whole.** On the materialized workflow, validation adds: every `enable` names a task; no target is enabled by two sources; a routed target declares no `when` of its own; every route's path exists in the source's output (the `when_output_path_unknown` check, read from the source instead of the target); and the derived dependencies keep the graph acyclic. Each failure is a structured diagnostic naming the route.

**D5 — A route is edited as a route.** `workflow.manage.patch` stages typed changes for `/tasks/{task}/routes/-`, `/tasks/{task}/routes/{i}` and `/tasks/{task}/routes/{i}/enable`, so a proposal reads "triage: when `answers.team.value == 'sales'` → enable `sales_responder`". Adding a branch is one patch: add the task, add the route. Removing a task that a route enables is refused with the route that still points at it.

**D6 — Existing guards stay what they are.** An authored `when` on a target remains a legitimate construct — a condition the target itself imposes — and decision skills assembled before this plan keep their guards and keep running. They are not rewritten; they are simply not route-editable until re-composed. This is two constructs with two meanings, not a compatibility layer.

**D7 — The fork is visible where it is authored.** The skill designer draws routes as labelled edges from the source to each target; a routed target's inspector shows "enabled by `triage` when …" from the derived guard. The run surface already reads the materialized workflow and shows derived guards unchanged.

## 3. Affected packages and contracts

`packages/schemas` (`routes` on the workflow task, the draft lowering, typed staged ops for routes), `packages/cybernetic-runtime` (`materializeSkillTasks` derivation, route validation, the route-check registry), `apps/aflow-orchestrator` (assembler, patch-to-proposal conversion, proposal application), `packages/web-product` (designer edges and inspector), `packages/platform-artifacts` (compose-skill's description of routes).

Stored workflows gain an optional `routes` field. No existing workflow changes shape.

## 4. Phases

### P1 — Routes in the model

**Delivered:** `routes` on the workflow task; the derivation (`deriveRouteGuards`, in `@aflow/schemas` so materialization and the designer share it) applied in both materialize paths; the D4 checks in `validateRoutes`; the route-check registry with the decision operation's checks. Exit: a hand-written workflow with routes runs the right branch for each output, and each D4 violation is refused with a diagnostic naming the route.

### P2 — Compose-skill lowers to routes

**Delivered:** the `decision` draft task lowers to an operation task with `routes` (one per distinct condition), its targets carrying only the dependency; agent, operation and human draft tasks accept `routes`, described on the draft schema; the assembler carries them. **Open:** the live run of the exit below. Exit: the live triage request from Plan 316 produces a skill whose stored form has routes on the decision and no guards on the responders, and runs every branch as before.

### P3 — Editing a route

**Delivered:** one typed staged op, `update_task_routes` (the complete new list — any patch under `/tasks/{i}/routes` lowers to it), authoring-only so the Coach union stays as it was; the proposal card shows routes added and removed as `when … → enable …`; ratification re-validates, so removing a still-enabled task is refused naming the route; `workflow.manage.patch` usage names the add-a-branch shape. **Open:** the live Helmsman run of the exit below. Exit: asking Helmsman to "send refund requests to a new refund handler" produces one proposal that adds the task and the route, in at most two attempts.

### P4 — The designer

**Delivered:** the designer draws edges from the derived guards, so each route is a labelled conditional edge from its source, while the node keeps the stored task; the inspector shows a source's routes and a routed target's "Enabled by". Exit: the triage skill shows its fork as one source with labelled edges.

## 5. How it is proven

- The same skill stored with routes and with hand-written guards runs identical branches for the same inputs.
- A route naming a task that does not exist, a path the source does not emit, or a target enabled by two sources is refused at validation, not skipped at run time.
- Renaming a choice option that a route reads is refused by the decision route check.
- Helmsman's refund edit is one proposal, reviewable as "add task, add route".
