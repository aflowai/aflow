---
name: cybernetic-skill-authoring
description: Background knowledge for designing, authoring, and maintaining cybernetic skills — the bundled (workflow + manifest + eval suite + activation) capability units used by the cybernetic agent. Covers the Helmsman/Runner/Coach/Driver ensemble, system agents and system skills, the platform-artifact registry, the compose-skill / bind-capability authoring path, StagedChange ratification, task context specs, typed step roles, and the skill-shop / catalog import path. For raw workflow schema, validation, and classic agent (`ai.agent.turn`) authoring, pair with the `flow-building` skill.
user-invocable: false
---

# Cybernetic Skill Authoring Guide

The cybernetic agent is a **persistent entity** that learns, accumulates capability, and improves through measured feedback. New capability is added by **authoring skills** — never by spawning more agents. This skill explains how skills are shaped, authored, validated, distributed, and managed alongside the system agents that run them.

> **Pair with `flow-building`.** Every cybernetic skill contains a workflow at its core. This skill covers what's _new_: the bundle, the loop, the authoring path, and the registry. For workflow schema, state variables, transitions, and validation layers, defer to `flow-building`.

## The cybernetic ensemble (system agents)

A cybernetic space is operated by **four system agents** defined in `packages/platform-artifacts/src/cyberneticAgents.ts`. They are _one entity_ externally; the split exists only to specialize internal function.

| System agent | Role                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| **Helmsman** | The interface, planner, and dispatcher. Talks to the user. Activates skills. Delegates work. Reviews proposals. |
| **Runner**   | Executes a single bounded task with a sealed tool surface and `TaskContextSpec`. No memory of other tasks.      |
| **Coach**    | Reviews completed runs after the fact, proposes refinements as `StagedChange`s for operator ratification.       |
| **Driver**   | Bootstraps and walks the graph for a workflow run; promotes outputs across tasks.                               |

You don't add a fifth agent to add a capability. You **author a skill** that the Helmsman activates and the Runner executes.

## What is a skill?

A **skill** is an atomic bundle binding five things:

1. **Goal** — narrative purpose (when this skill applies, what success looks like).
2. **Workflow** — the task graph (uses the workflow substrate from `flow-building`, but with typed `StepRole` dispatch — `workflow_bootstrap`, `workflow_task`, `workflow_parallel_join`).
3. **Eval suite** — optional; grades production runs when present (the Coach authors evals from evidence — Plan 200). Deterministic criteria (`threshold` / `contains` / `trace_bound`) fire unconditionally on every terminal run; `judge` criteria are binary-rubric and advisory until measured (Plan 269).
4. **Activation** — when the Helmsman should activate it (trigger patterns, contraindications).
5. **Mode** — how runs of this skill relate over time: `optimization` (chasing a measurable objective), `process` (repeatable workflow), or `project` (one-off plan-of-work).

Skills carry an **origin**:

- `platform` — bundled in `@aflow/platform-artifacts`, identical across tenants, resolved by registry overlay (Plan 106).
- `operator` — authored in this space (almost always via `compose-skill`).
- `cloned` — installed from the skill catalog (skill-shop) — operator-owned writable copy.
- `helmsman` — authored autonomously by the Helmsman.

Source-of-truth schemas: `packages/schemas/src/cybernetic/skill.ts` (`SkillManifestSchema`, `SkillModeSchema`, `SkillOriginSchema`, `SkillConcurrencyPolicySchema`).

## Authoring paths (all declarative, all user-authorable)

There is **no `skill.manage.put` API.** A new skill enters a space by exactly one of three paths:

| Path                                 | When to use                                                                   | How                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`compose-skill`** (recommended)    | Authoring a brand-new skill from intent.                                      | Helmsman delegates to the platform skill `compose-skill`. It runs design → validation → emits a `skill_compose` `StagedChange`. Operator ratifies. Atomic land.                                                                                                                                                                                   |
| **Store install** (catalog clone)    | A platform-curated skill already does what you need.                          | Browse `/s/[space]/store?kind=skill`. Preview via `POST /v1/spaces/:spaceId/store/install-preview { catalogId }`, then `POST /v1/spaces/:spaceId/store/install { catalogId, expectedVersion, idempotencyKey }` (echo the preview's `catalogVersion`). Skill lands as `origin: 'cloned'` — fully editable copy, not a read-only platform artifact. |
| **Platform-bundled** (system skills) | Capability shared by every tenant (e.g., `compose-skill`, `bind-capability`). | Edit `packages/platform-artifacts/src/skillBundles.ts`, redeploy. No per-tenant seeding (Plan 106). Registry overlay makes it instantly available everywhere.                                                                                                                                                                                     |

Direct hand-authoring of a skill bundle (without `compose-skill`) is technically possible by writing the bundle and invoking `skill.compose.propose` from a custom workflow, but this bypasses the design-stage evaluators and is **not the supported path**. If you need a skill, run `compose-skill`.

## The cybernetic loop

```
TRIGGER → HELMSMAN → activate skill → DRIVER walks graph → RUNNER (per task) → outputs → COACH reviews → proposes StagedChange → HELMSMAN surfaces to operator → ratify or reject → loop tightens
```

Three nested loops:

- **Inner (per step)**: step result → next step within a task.
- **Middle (per run)**: run completes → Coach reviews → emits proposals if scoped triggers fire.
- **Outer (over time)**: ratified refinements compound; the entity's skill set sharpens.

## System skills (platform-bundled)

Two ship today, both in `packages/platform-artifacts/src/skillBundles.ts`:

| Skill               | Slug              | Purpose                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **compose-skill**   | `compose-skill`   | The skill that authors skills. Multi-task workflow: analyze-intent → prepare-design-surface → draft-task-graph → validate (graph, source coverage, capability grants) → assemble-workflow → validate-and-propose. Emits a `skill_compose` `StagedChange`.                                                                                |
| **bind-capability** | `bind-capability` | Wires external integrations (APIs and MCP servers) into the space. Resolve target → draft integration definition → propose binding. Often invoked as a sub-handoff from `compose-skill` when a needed capability isn't bound yet. See [`docs/dev/integrations-and-capabilities.md`](../../../docs/dev/integrations-and-capabilities.md). |

**No other meta-skills in V2.** Plan 109 sketches future ones (`manage-api-integration`, `compose-eval-suite`); not implemented.

## Quick map of the references

- **[skill-bundle.md](references/skill-bundle.md)** — `SkillManifest`, mode, origin, concurrency, eval suite shape, activation, the typed `StepRole` enum.
- **[task-context.md](references/task-context.md)** — `TaskContextSpec` (strategy, tools, capability grants, search, learnings, prior results), graph contract runtime (Plan 123), cross-task typed channels (Plan 129).
- **[compose-and-bind.md](references/compose-and-bind.md)** — How `compose-skill` and `bind-capability` work step-by-step; `StagedChange` kinds and ops; ratification flow; failure handoffs.
- **[system-and-shop.md](references/system-and-shop.md)** — Platform-artifact registry & overlays (Plan 106), modifying system skills/agents, the skill-shop / catalog (Plan 108) and its current maturity, install operations.

## Hard rules for cybernetic spaces

- **Don't add a new system agent to add capability.** Author a skill instead.
- **Don't bypass `compose-skill` for new skills.** It enforces validation, capability grants, and eval scaffolding the runtime depends on.
- **Don't write platform skills into per-tenant storage.** They live in the registry; redeploy to ship changes.
- **A suite with judges must anchor them deterministically.** A bundle's eval suite is optional, but when present a judge criterion requires at least one deterministic criterion beside it, and a judge-only tier must carry weight 0 (`validateEvalSuiteDiscipline`). Skill tasks can never reference an `eval.*` operation — the measurement plane grades skills and must stay invisible to them (Plan 269).
- **Tools are task-scoped, not space-scoped.** Each task declares the tools and capabilities it actually needs in its `TaskContextSpec`. The Helmsman has no ambient tool surface beyond its core control ops.
- **`StagedChange`s require operator ratification by default** (Plan 117, Plan 115). Auto-apply is reserved for narrow categories.
- **`ai.agent.turn` may appear inside a Runner task** but must not be the top-level orchestrator of a cybernetic skill.

## Patterns that worked

The first live week of the Alpaca trading skills (`packages/platform-artifacts/src/skillCatalog/`) taught these. Each one names the code or the pull request that shows it. Apply them to any skill or agent you design.

1. **Aggregate with a deterministic deriver, never a model.** The Strategy Desk once asked a no-tool model to fold seven lens verdicts, and a validator refused folds that did not match (#372). The `trading.desk-tally` deriver (`strategyDeskTally.ts`) now computes the tally wherever the set is read, and #374 deleted the aggregate, its validator and that refusal class.
2. **Pass one typed record per unit of time between tasks.** The approved set is one document per trading day at `/research/{tradingDay}/approved-theses.json`, with no slot keys, and a later desk run replaces it (#374). Its required keys are fixed, and `ApprovedSetSchema` (`dailyTradingCycleApproved.ts`) holds the reader to them. The writer builds the document from an operation template over contract-checked agent outputs. Unknown fields pass through, so an operator can write a set by hand.
3. **The agent decides and executes.** Refuse only a structural fault. The decide contract refuses a thesis that names no approved candidate, departs from its candidate's instrument, direction or arm, or opens a candidate twice in a day, and nothing else (#374). #374 removed the caps no strategy asked for (`maxThesesPerDay`, `maxPositionSizePct`, `maxGrossExposurePct`, `regimeCaps`).
4. **Review by quorum, with silence as approval.** A lens that says nothing approves. A candidate fails only when 4 of the 7 lenses reject it. The desk reviewer may veto by name with a stated reason (`DESK_TALLY_RULE`). The review fails closed only on total outage: a desk where every lens failed ends `review_failed` and writes no set (#374).
5. **Store an intention as a ledger document, with its condition as data.** A deferred order is a doc at `/portfolio/intentions/{clientOrderId}.json` carrying its `entryCondition`. Every open-market cycle settles the pending intentions first and rechecks each condition on a fresh snapshot (`dailyTradingCycleProse.ts`, execute-orders rule 1). That recheck lives in prose today, so the model applies it.
6. **Derive idempotence from identity.** The client order id is `{tradingDay}-{slotKey}-{thesisId}-open|close`, minted by the cycle that proposed the order and carried unchanged through deferral. The intention doc is named by that id, and a re-run meets the broker's duplicate refusal instead of a second order. The opened-twice guard (`tradingApprovedThesesValidator.ts`) reads the thesis and cycle docs the record step wrote, never a list the model wrote (#374).
7. **Rehearse before install.** `yarn store:smoke <catalogId> --record` records a pass per bundle version, content hash and plan steps hash in `storeSmokes.json`, and the hash stamp refuses a new version without one. A bundle's content hash covers its listing, not its member skills, so a member change needs a version bump. A dry run (`workflow.run.start` with `dryRun: true`, #375) runs real agents in a live space and holds every write.
8. **Report a quiet run with its counts.** Execute-orders reports `submittedCount`, `deferredCount` and `failedCount` beside a disposition per order (`dailyTradingCycle.ts`). A cycle that placed nothing then reads as quiet, not as broken.
9. **Derive state from a durable record, never a cache.** #375 took eight commits. Four of them closed a hole of one shape: the Redis session hash answered "live" once it was lost, rewritten or corrupt. The fix moved the answer to the run row in Postgres (`resolveSessionDryRun`), and a write whose row cannot be read now fails.

## Pitfalls

Each pitfall names its check. Skill validity (`packages/cybernetic-runtime/src/scheduling/designPitfalls.ts`) raises the graph checks as advisories at compose, ratify, update and read. `skill.compose.propose` returns them in `advisories`. None blocks a skill. `designPitfallCensus.test.ts` lists the catalog skills that still carry one.

1. **A model asked to copy.** The reflection's `read-day` agent copies named ledger docs into its output, and it failed on shape two nights running (live runs `afa8dc4e` and `b5ed1644`, from the operator's space). #374 then taught argument coercion to read twice-encoded strings. A copy needs no model. **Check:** `model_copy_task` flags an agent whose goal states a copy, reproduce or transcribe task and asks no judgment, or whose output mirrors its inputs one to one. It finds `read-day`, the Strategy Desk's `read-ledger` and the Campaign Successor's `read-boundary-ledger` today.
2. **A removed rule lingers where the model reads.** After #374 dropped the caps, campaigns started earlier still stored them. The desk, the reflection and the charter handed that whole config to their models, which cited the caps until #376 projected each read to the declared contract fields. Old ledger docs carry the same risk, so #376 also marks such caps inert in every prompt (`LEGACY_CAPS_RULE`). Removing a rule means removing or marking every document the model reads. **Check:** `dropped_config_field_named` flags a task whose prose or template still names a campaign field the version drops. It runs where the caller holds the old contract: a Store update compares the installed manifest. Project every config read to the declared fields as well, because no check sees a whole config handed over.
3. **A write without its precondition.** The Strategy Desk's `write-folder-memo` wrote `research/{tradingDay}/` with `host.file.put` and failed on the missing directory. Strategy Desk version 10 sets `createParents: true`. **Check:** `write_parent_unproduced` flags a `host.file.put` under a directory that neither `createParents: true` nor an earlier task creates. The `host.file.put` registry entry already carries the `createParents` pitfall. `memory.store.put` creates its parents itself, so it needs neither.
4. **A nullable input with no stated reading.** Alpaca's account read carries no `fractional_trading`, so the input read null every cycle. Every short entry then sized in whole shares as `whole_share_capability_unknown` until #376 read the account configuration. **Check:** `nullable_input_reading_unstated` flags an agent input a producer may give as null where no line of the prose names the input and says null.
5. **An API definition the space does not hold.** The Daily Trading Cycle's optional `ingest-calendar` reads `market-calendar`, which the bundle ships no definition for. It fails every cycle, as the smoke record shows, and readiness skips optional tasks, so nothing reports it. **Check:** a bundle install warns on every API definition a skill names that neither the bundle nor the space holds (`danglingApiDefinitionWarnings`).
6. **A record from before the run's own writes.** The cycle's `record` binds `ingest-positions`, read before `execute-orders` submits, so its snapshot reported no positions in the cycle that opened one. **Check:** `record_reads_superseded_state` flags a record or report task that binds an API read when a later task writes the same service. Read the state again after the write, or label the input's vantage in the prose.
7. **What a skill announces is designed late.** The hourly check spoke only on defects, so the first trade reached nobody on Slack. This is operator evidence, and no check can find it. Design what the skill announces at authoring time, in its contract.
8. **Coercion and one retry do not rescue a large structured output.** #374 added argument coercion and one retry on malformed arguments, and `read-day` still fails on shape. Remove the model from that seam. The `model_copy_task` check finds the seam.
9. **A cap enforced by a model aggregate.** The aggregate refused on rules the strategy never asked for (#372, removed in #374). Tools, not shackles: enforcement belongs in code the agent can see, never in a model's hidden veto.

`compose-skill` carries 7 and 9 as prose in its `draft-task-graph` goal, because no validator can check them.

## Human-in-the-loop tasks (Plan 156)

Cybernetic skills use `type: 'human'` workflow tasks for moments where the run legitimately cannot proceed without a person. Every pending human task surfaces as an Action Center (Plan 156) item — paused steps, Coach proposals, gate-egress requests, and HITL tasks share one inbox; the operator resolves any of them with the same `<HitlResolution>` control.

Two intents live on a human task. Both pause the run and create an Action Center item; the dispatcher picks the rendering by `intent`:

| `intent`    | Output shape                                                               | UI                                                           | Use for                                                                  |
| ----------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `'collect'` | Derived from your `produces[]` (the assembler builds the JSON schema)      | `<SchemaForm>` matching the schema; submitted value = output | Typed input — "which dataset?", "model config", "edit this draft"        |
| `'approve'` | Platform-fixed: `{ decision: 'approved' \| 'rejected', comment?: string }` | Approve / reject button row with optional comment textarea   | Gates before irreversible work — "submit?", "ratify?", "destructive op?" |

Authoring rules:

- **`compose-skill` enforces the discriminator.** The `HumanTaskSchema` in `packages/schemas/src/cybernetic/composeSkill.ts` requires `intent`; the default is `'collect'` if omitted, but `draft-task-graph` prompts the LLM to set it explicitly because the choice changes the rendered UI.
- **Approval tasks must NOT declare `produces[]` or `outputContract.schema`.** The platform owns the output shape; a custom contract on an `intent: 'approve'` task is rejected by `WorkflowTaskSchema`'s refinement (`packages/schemas/src/operations/workflow.ts`).
- **No `inputBindings` on human tasks.** The human IS the input — bindings are auto-derived from `consumes[]` on operation/agent tasks instead.
- **Don't add a human task to "show progress."** Chat already surfaces progress. A human task pauses the workflow run until the operator acts; only use one when proceeding without the answer is wrong.
- **Don't use a human task as a sanity check on agent output.** That's a `judge` task (`AgentTaskKind`), or a `validate-*` operation task.

What the Helmsman can do mid-chat (different surface, same vocabulary):

- `human.chat.ask` — author a fresh ask inline in the active chat session. Step pauses the Helmsman session itself (not a workflow run); UI is the same `<HitlResolution>` inside an `<HitlInline>` card.
- `human.action_center.focus` — when an item already exists (Coach proposal, paused HITL step, gate), point the operator at it instead of authoring a redundant ask.

These two Helmsman tools and the `type: 'human'` workflow path coexist — Helmsman uses them for ad-hoc interactions; compose-skill uses workflow human tasks when the **skill's contract** requires a person at a specific point in the graph.

## When to fall back to `flow-building`

You are reading the wrong skill if:

- You are authoring a classic capability flow (orchestrator, agent-builder, api-configurator, etc. — non-cybernetic spaces).
- You need raw workflow schema, transition shapes, validation rules, or `${state.var}` resolution mechanics.
- You are debugging a step-level issue inside a Runner task.

Open `flow-building` for those.
