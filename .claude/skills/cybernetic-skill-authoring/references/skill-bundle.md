# Skill Bundle Schema

A skill is a single atomic bundle. The shape below is what `compose-skill` emits as the payload of a `skill_compose` `StagedChange` and what gets stored under `/skills/{slug}/manifest.json` in space memory once ratified.

Source of truth: `packages/schemas/src/cybernetic/skill.ts`, `packages/schemas/src/cybernetic/eval.ts`, `packages/schemas/src/cybernetic/stagedChange.ts` (look for `SkillComposeBundleSchema`).

## SkillManifest

| Field                  | Type                                               | Required                                         | Notes                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skillId`              | string                                             | yes                                              | Stable identifier — `slug`-shaped (`^[a-z][a-z0-9-]*$`). Used in cross-references.                                                                                           |
| `name`                 | string                                             | yes                                              | Human-readable.                                                                                                                                                              |
| `goal`                 | string                                             | yes                                              | Narrative purpose. The Helmsman uses this to decide activation.                                                                                                              |
| `mode`                 | `optimization` \| `process` \| `project`           | optional (defaults to `process` for back-compat) | How runs relate over time. Drives Coach behavior and graph shape.                                                                                                            |
| `origin`               | `platform` \| `operator` \| `helmsman` \| `cloned` | yes                                              | See SKILL.md — drives ratification authority and overlay visibility.                                                                                                         |
| `workflowSlug`         | string                                             | yes                                              | Slug of the embedded workflow (matches `WorkflowDefinition.flowId`).                                                                                                         |
| `evalSuiteRef`         | EvalSuiteRef                                       | optional                                         | Ref to the `CyberneticEvalSuite`. A skill with no suite is valid — the Coach authors production evals from evidence; a terminal run without one records decision `no_suite`. |
| `activationRef`        | ActivationRef                                      | optional                                         | Ref to the activation pattern for the Helmsman.                                                                                                                              |
| `concurrency`          | `SkillConcurrencyPolicy`                           | optional                                         | `{ maxParallelTasksPerRun?, maxConcurrentRuns?, failureMode?, perUserSerial? }`                                                                                              |
| `requiredCapabilities` | string[]                                           | optional                                         | API/MCP capability slugs that must be bound before this skill can run.                                                                                                       |
| `sourceCatalogId`      | string                                             | optional                                         | If installed from the catalog (skill-shop), the original entry id.                                                                                                           |
| `sourceVersion`        | string                                             | optional                                         | The catalog version the install was based on.                                                                                                                                |
| `installedAt`          | ISO timestamp                                      | optional                                         | When the cloned copy entered the space.                                                                                                                                      |

### Skill mode (the most-missed field)

| Mode           | When to choose                                                   | Run-to-run relationship                                                                                                                |
| -------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `optimization` | A measurable objective the entity should keep getting better at. | Each run is judged against an objective. Coach proposes refinements aimed at moving the metric. Suits ML loops, retrieval tuning, etc. |
| `process`      | A repeatable workflow with a pass/fail outcome.                  | Each run is independent. Coach watches for regression and broken steps. Default for most skills.                                       |
| `project`      | A bounded plan-of-work executed once.                            | One run, possibly resumed. Tasks compose a project plan. Coach reviews on completion.                                                  |

`packages/schemas/src/cybernetic/skill.ts` reuses `WorkflowModeSchema` for `SkillModeSchema`.

### Concurrency policy

`SkillConcurrencyPolicySchema`:

- `maxParallelTasksPerRun` — 1 to 20 (graph-compiled fan-out cap).
- `maxConcurrentRuns` — 1 to 50, or `'unlimited'`.
- `failureMode` — `'isolate'` (siblings continue, default in Plan 131) or `'cancel_siblings'`.
- `perUserSerial` — boolean. If `true`, serializes runs per-user.

## Workflow (inside the bundle)

The embedded `WorkflowDefinition` follows the same schema as `flow-building/references/schema.md`, with these cybernetic-specific conventions:

- **At least one bootstrap step**: `role: 'workflow_bootstrap'`, runs once at the start to seed run state and ledger.
- **Tasks are typed**: `role: 'workflow_task'` for any step the graph scheduler dispatches as a task. Each must have a `TaskContextSpec` (see `task-context.md`).
- **Joins are typed**: `role: 'workflow_parallel_join'` where parallel tasks merge.
- **No top-level `ai.agent.turn` orchestrator.** The graph is the orchestration. Inside a Runner task, `ai.agent.turn` is fine for the LLM call.
- **Outputs flow through typed cross-task channels** — see Plan 129 in `task-context.md`.

## Eval suite

Source: `packages/schemas/src/cybernetic/eval.ts` (`CyberneticEvalSuiteSchema`).

The suite is **optional in the bundle** (the Coach authors production evals from evidence; a suite, when present, must carry at least one criterion). Criteria live in three scopes — `goalCriteria`, `taskCriteria` (keyed by taskId), `trajectoryCriteria` — each an array of the four-type union:

- `threshold` — numeric metric vs. operator (deterministic).
- `contains` — pattern presence in an output field (deterministic).
- `trace_bound` — runtime trace metrics, e.g. `step_count` ≤ N, `duration_ms` ≤ N (deterministic).
- `judge` — LLM-as-judge against a **binary-scale rubric** (1–5 entries), critique-then-verdict, optional `referenceAnswer` and `model` override. Binary is the only scale — it is what precision/recall is defined over.

Firing is **unconditional**: a suite present on a terminal, non-operator-cancelled production run always evaluates deterministically — there is no suite trigger enum and no suite-level sampling. The one cost lever is `judgeSamplingRate` (optional, default 1): the probability a judge criterion dispatches on a non-failed run (failed runs are always judged); a sampled-out criterion is recorded `not_selected`, never silently skipped. Results land in the run's typed `RunEvaluationEnvelope` (`workflow_runs.evaluation_json`, one writer, a six-value decision record) — "did eval fire" is a read, not a code-reading exercise.

Discipline (validated as structured diagnostics via `validateEvalSuiteDiscipline`): a suite with judge criteria must contain at least one deterministic criterion (an uncalibrated judge cannot anchor its own grading), a tier consisting solely of judge criteria must carry weight 0 (advisory), and deterministic criteria must carry score weight somewhere. Judges are advisory until measured — see the measurement plane below.

### The measurement plane (golden dataset, Plan 269)

The suite above is the **online** plane: it grades live production runs. The **offline** plane is a per-skill versioned **golden dataset** (immutable case revisions; draft → operator ratification) replayed as **frozen eval batches** — real workflow runs at a pinned revision, excluded from every production surface, graded deterministically first with judges advisory. The **operator owns the dataset** (case CRUD, labels, baseline pins are an authenticated REST surface with no agent path); the Helmsman holds exactly seven `eval.*` ops — dataset/batch reads, `eval.batch.run` on explicit operator request, and `eval.case.promote`, which drafts a case from a production run's own persisted record for the operator to ratify. Skills never see the eval plane: a skill task or agent tool referencing an `eval.*` operation is rejected at validation (the subject must not see the ruler). Judge trustworthiness is measured, not assumed: operator labels from each batch's uniform validation slice produce per-criterion precision/recall/κ scorecards in the skill designer's Measurement tab.

## Activation

`ActivationRef` points to a stored `ProcedureActivation` describing when the Helmsman should pick this skill: trigger patterns (regex/embedding hints over user intent), contraindications, priority. Activation patterns are themselves refinable by Coach proposals.

## Where bundles live in space memory

After ratification, a skill is materialized as files under the space's memory document tree (paths in `packages/cybernetic-runtime/src/skillLifecycle.ts`):

```
/skills/{skillId}/manifest.json      # SkillManifest
/skills/{skillId}/projection.json    # SkillProjection
/workflows/{slug}/workflow.json      # WorkflowDefinition
/workflows/{slug}/activation.json    # ProcedureActivation
/workflows/{slug}/revisions/...      # immutable revision snapshots
/evals/{slug}/suite.json             # CyberneticEvalSuite (when present)
/evals/{slug}/baseline.json          # rolling production baseline
```

Loaders (`packages/database/src/...`) check the platform-artifact registry first, then fall back to space memory — so platform-bundled skills shadow space-local at the same slug.

## Reference example

Read `packages/platform-artifacts/src/skillBundles.ts` end-to-end for a concrete, production bundle. `compose-skill` (lines ~100–600) shows:

- `WorkflowDefinition` with bootstrap + multi-task graph + parallel-join.
- Per-task `TaskContextSpec` declaring scoped tools and capabilities.
- Full `CyberneticEvalSuite` with `contains` and `trace_bound` criteria.
- `SkillManifest` block at the bottom binding everything together.

`bind-capability` (~lines 593–800) shows the same shape for a smaller skill.
