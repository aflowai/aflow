# Skill contract validity (Plan 190)

The **contract membrane**: a structured skill earns its complexity over an open-text `skill.md` by being **machine-validatable**. This module is the one place that decides "is a skill's config coherent against the current platform rules?" — surfaced as a structured verdict, enforced at execution, actionable by a human/Helmsman/Coach.

> High-level invariants live in root `CLAUDE.md` → "Skill contract validity". The authoritative spec is `docs/plans/aflow/completed/190-skill-validity-standing-property.md`. This README is the operational guide for working _in_ this code.

## The three functions (the entire API)

| Function                            | Side      | Use it when                                                                                                                                                                                                                                                                           |
| ----------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `materializeAndValidateSkillConfig` | write     | authoring / compose / proposal / ratify / install — derive **and** validate, returns `{ materializedTasks, validity }`. Never throws. Pass `bundle:` to also run the bundle-level dimensions (eval-linkage, refs, uiOutput, op-task-only).                                            |
| `ensureCurrentSkillValidity`        | read      | a high-stakes read that must **recompute** against current rules and never trust a stamp (`workflow.manage.get`, the run-start gate).                                                                                                                                                 |
| `materializeSkillTasks`             | execution | the **derive-only** hot path (`resolveWorkflowForRun`) — materialize the tasks, **no** re-validation. Validity is already settled at the run-start gate; re-validating per dispatch has no enforcement value (pinned revision, no mid-run rule change, in-flight runs aren't killed). |

## Hard rules (a guard test enforces the first)

1. **One detector.** `validateWorkflowGraph` + `deriveOpBoundProducerShapes` may be imported **only** by this module. Every other site routes through the three functions above. `__tests__/detectorConsolidation.contract.test.ts` fails the build if anything else imports them — so the coverage can't silently re-scatter (the Plan 187 failure mode).
2. **Recompute at read; the cache is advisory.** `SkillProjection.contractValidity` (+ `contractValidityHash`) is a perf cache for high-frequency _surface_ reads only (attention / SpaceContext, via `cachedOrRecomputeValidity`). The execution gate and `manage.get` **recompute** — never gate on the cache.
3. **The executed artifact is the materialized one.** Derivation fills op-bound producer contracts from the consuming op's input schema. Validation, surfacing, **and execution** must operate on the _derived_ form. Any new path that resolves a workflow for execution must materialize first (`resolveWorkflowForRun` does). The founding incident (and a regression we shipped and fixed) was validating one form and executing another.

## Where each dimension runs (a conscious boundary)

- **Always-on** (run wherever a workflow is validated, including the read/execution gate): graph structure + op-input contract — incl. `op_input_undeclared_field` (removed/renamed op fields). These bite even on a plain tasks-only recompute.
- **Bundle-context-only** (need the eval suite / manifest, so they run at author / ratify / install / CI, not on a plain read-side recompute): `eval_field_not_produced` (eval ↔ output-field linkage), `dangling_*_ref` (manifest ref coherence), capability-grant well-formedness, uiOutput shape.

## Adding a new validation dimension

1. Emit a `SkillDiagnostic` with the right `dimension` + `severity` — **structured**, never a `[kind] detail` string. Promote fields the checker already knows (`taskId`, `field`, `producerTaskId`, `operationId`) out of `detail`.
2. Put it **inside** the right home: a graph/op-input check goes in `graphValidation.ts` (always-on); a bundle check goes in `appendBundleDiagnostics` here (author-time). Never add a second checker or a parallel verdict.
3. **Contract validity is space-independent** (`f(skill, rules)` only). "Is this binding present _in this space_?" is the **readiness** axis (`activationStatus`), not contract validity. Keep the line: a malformed/dangling ref _inside_ the skill is a contract error; a missing binding _in this space_ is readiness.
4. **Derive-don't-mirror** any shared knowledge. E.g. the eval reserved-field set is exported from the runtime grader (`CONTAINS_RESERVED_FIELDS` in `evalRunnerCriterion.ts`) and imported here, so the static check and runtime resolution can't drift.
5. Be **sound for rejection** — only flag when you can prove a defect. A false positive (flagging a valid skill) erodes the whole membrane; prefer skipping the ambiguous case (e.g. open/undeclared producer shapes are not flagged).

## Readiness (two orthogonal axes)

`computeSkillReadiness` (in `@aflow/schemas/skillProjection`) composes **contract validity** (this module) with **capability/activation readiness** (`activationStatus`) into `canRun` / `canShow` / `needsSetup`. They are distinct axes — never merge the enums; merging loses "your skill is fine, it just needs a binding" vs "your skill's contract is broken".
