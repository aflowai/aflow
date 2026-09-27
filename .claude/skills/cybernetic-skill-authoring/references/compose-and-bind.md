# compose-skill, bind-capability & StagedChange Ratification

The two platform-bundled meta-skills are the only sanctioned authoring path for new cybernetic skills. They produce `StagedChange`s — atomic, operator-ratified proposals — rather than mutating space state directly.

## compose-skill

Source: `packages/platform-artifacts/src/skillBundles.ts` (the `compose-skill` block, ~lines 100–600).

`compose-skill` is itself a cybernetic skill. The Helmsman activates it when a user describes a capability that doesn't exist yet, or when repetition signals "this should be a skill" (the Helmsman's heuristic: 3+ similar tasks → consider composing).

### Tasks (in order)

| Task                         | Role            | Purpose                                                                                                                                                                   |
| ---------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analyze-intent`             | `workflow_task` | Parse the request, extract goal, audience, mode hints. Decide if a skill is the right artifact (vs. a one-off task or memory note).                                       |
| `prepare-design-surface`     | `workflow_task` | Survey existing skills, catalog ops, bound capabilities. Surface conflicts and overlaps. Decide reuse vs. new.                                                            |
| `draft-task-graph`           | `workflow_task` | LLM-driven decomposition into tasks with `TaskContextSpec` per task, transitions, parallel structure.                                                                     |
| `validate-task-graph`        | `workflow_task` | Run `skill.compose.validate_task_graph` — ensures the graph is reachable, non-cyclic, has bootstrap, joins are paired.                                                    |
| `validate-source-coverage`   | `workflow_task` | Run `skill.compose.validate_source_coverage` — every required input has a declared source.                                                                                |
| `validate-capability-grants` | `workflow_task` | Run `skill.compose.validate_capability_grants` — every operation/API/MCP tool has a corresponding grant. Halts and hands off to `bind-capability` if anything is missing. |
| `assemble-workflow`          | `workflow_task` | Stitch validated tasks into a final `WorkflowDefinition`.                                                                                                                 |
| `validate-and-propose`       | `workflow_task` | Final shape check, emit a `skill_compose` `StagedChange` via `skill.compose.propose`.                                                                                     |

There is no eval-suite drafting task: the bundle's eval suite is optional (the Coach authors production evals from evidence — Plan 200), and when a bundle does carry one, `skill.compose.propose` validates it in-schema (≥1 criterion, `taskCriteria` keys must be real taskIds) plus the `validateEvalSuiteDiscipline` diagnostics.

### Halts and handoffs

If `validate-capability-grants` finds a missing API/MCP capability, the workflow **pauses** with `kind: 'compose-skill-handoff'`, `reason: 'needs_binding'` and a `handoffPayload` describing what to bind. The Helmsman activates `bind-capability` to resolve it, then resumes `compose-skill`. Other halt reasons (`policy_disabled`, `validation_failed_unrecoverable`) bubble to the operator.

### Output

A `StagedChange` of `kind: 'skill_compose'` with `op: 'skill_compose'` carrying a `SkillComposeBundle` payload (workflow + manifest + optional eval suite + activation). On ratification, the bundle lands atomically in space memory (`/skills/{skillId}/`, `/workflows/{slug}/`, `/evals/{slug}/` — see `skill-bundle.md`).

## bind-capability

Source: same file, ~lines 593–800.

`bind-capability` wires external APIs and MCP servers into the space. Either invoked directly by the Helmsman (operator says "I have a Stripe key, hook it up") or as a sub-handoff from `compose-skill`.

### Tasks

| Task                   | Role            | Purpose                                                                                                 |
| ---------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `resolve-api-target`   | `workflow_task` | Identify the target service. Search bound capabilities first; reject duplicates.                        |
| `draft-api-definition` | `workflow_task` | Author a structured API definition (endpoints, auth shape, base URL, egress policy hints).              |
| `propose-binding`      | `workflow_task` | Emit a `capability.binding.upsert` (or `capability.definition.upsert`) `StagedChange` for ratification. |

### Output

A `StagedChange` of kind `capability_binding`. After ratification the binding is available to any task whose `TaskContextSpec.capabilities` references it.

## StagedChange anatomy

Source: `packages/schemas/src/cybernetic/stagedChange.ts` (lines 507–868).

```ts
type StagedChange = {
  changeId: string;
  kind: StagedChangeKind;
  authorityTier: 'auto_apply' | 'stage_for_review' | 'require_operator';
  resolutionRoute: 'tenant_ratification' | 'platform_issue';
  ops: StagedChangeOp[]; // discriminated union of ~25 op kinds
  rationale: string; // why the Coach (or compose-skill) is proposing this
  proposedBy: { actor; runId };
  state: 'pending' | 'ratified' | 'rejected' | 'platform_diagnostic';
};
```

### StagedChange kinds (high-level)

| Kind                    | Typical author    | What it does                                                                          |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| `skill_compose`         | `compose-skill`   | Lands a brand-new skill bundle (workflow + manifest + evals + activation) atomically. |
| `capability_binding`    | `bind-capability` | Binds (or removes) an external API / MCP capability.                                  |
| `directive_amendment`   | Coach / operator  | Amends governance directives (constitutional rules).                                  |
| `workflow_refinement`   | Coach             | Targeted patches to an existing skill's workflow (replace task, raise budget, etc.).  |
| `workflow_block`        | Coach / operator  | Quarantines a misbehaving skill from activation.                                      |
| `context_strategy`      | Coach             | Promotes a curated context bundle for a task.                                         |
| `learning_merge`        | Coach             | Merges a new lesson into a task's learnings slot.                                     |
| `pattern_flag`          | Coach             | Flags a recurring failure pattern for operator attention.                             |
| `eval_criterion_change` | Coach / operator  | Adds, removes, or updates an eval criterion.                                          |
| `platform_issue`        | Coach             | Read-only diagnostic targeting a platform-owned skill (e.g., `compose-skill` itself). |

### StagedChange ops (concrete change set)

A single `StagedChange` carries one or more typed `ops`. Examples (discriminated by `op` tag):

- Task graph: `update_task_goal`, `add_task`, `remove_task`, `reorder_tasks`, `update_task_dependencies`, `update_task_context_spec`.
- Workflow-level: `update_outcome_threshold`, `update_activation_hint`, `add_trigger_pattern`, `update_iteration_policy`, `promote_context_strategy`, `block_workflow`, `unblock_workflow`, `flag_pattern`.
- Eval: `eval.criterion.add`, `eval.criterion.remove`, `eval.criterion.update`.
- Skill: `skill_compose` (new bundle).
- Capability: `capability.definition.upsert`, `capability.binding.remove`.
- Directives: `amend_directives`.
- Platform: `platform_issue`.

### Authority tiers

- `auto_apply` — bypasses ratification (reserved for safe, narrowly-scoped proposals; default is _not_ auto).
- `stage_for_review` — operator approval required (the common case).
- `require_operator` — operator must approve in-person; cannot delegate.

### Resolution routes

- `tenant_ratification` — the proposal can be ratified in this space. The Helmsman surfaces it via `proposal.list` / `proposal.get`. Operator says yes/no; `proposal.ratify` or `proposal.reject` finalizes.
- `platform_issue` — the proposal targets a platform-owned skill (e.g., `compose-skill` itself). It is **read-only** in this space; the Coach is reporting a diagnostic for the platform team. Calling `proposal.ratify` returns `PROPOSAL_NOT_RATIFIABLE`. Surface to the operator as "diagnosed but can't be applied here."

## Operations the Helmsman uses

| Operation                | Purpose                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `proposal.list`          | Enumerate pending proposals (defaults to `pendingOnly: true`). Carries `resolutionRoute` for branching.  |
| `proposal.get`           | Fetch a single proposal's full payload.                                                                  |
| `proposal.ratify`        | Apply a `tenant_ratification` proposal atomically. Errors on `platform_issue`.                           |
| `proposal.reject`        | Reject with optional `reason`; the Coach learns from rejection rationale.                                |
| `skill.compose.propose`  | Workflow-internal — emits a `skill_compose` `StagedChange`. **Don't call from outside `compose-skill`.** |
| `skill.manage.archive`   | Soft-archive a skill (Plan 119). Preserves history, removes from activation.                             |
| `skill.manage.unarchive` | Restore an archived skill.                                                                               |
| `skill.manage.purge`     | Hard-delete an archived skill (and its run history).                                                     |
| `skill.manage.preview`   | Read-only inspection of a skill bundle.                                                                  |
| `workflow.manage.get`    | Fetch a skill's workflow + ledger summary (recent runs, best score, learnings, budget).                  |
| `workflow.manage.patch`  | RFC 6902 patch on workflow-level metadata (raise `budget.maxRuns`, mark abandoned, etc.).                |

`workflow.manage.put` (full replace) is not available in cybernetic spaces — refinements go through StagedChanges so the Coach's rationale and the operator's approval are recorded.

## Common patterns

### "I want a new skill"

1. Helmsman delegates to `compose-skill` with the user's intent.
2. If a capability is missing → halts → Helmsman runs `bind-capability` → resumes.
3. `skill_compose` `StagedChange` lands in `/coach/staged/`.
4. Helmsman summarizes for the user: name, goal, ops, rationale.
5. User says "yes" → `proposal.ratify` → skill files materialize under `/skills/{slug}/`.

### "Coach proposes a refinement"

1. After a run completes, Coach reviews trace + outcome.
2. If a regression / scarcity trigger fires, Coach drafts a `workflow_refinement` (or other kind) with rationale.
3. Proposal lands in `/coach/staged/` with `resolutionRoute: 'tenant_ratification'`.
4. Helmsman surfaces it; operator ratifies, rejects with reason, or ignores.

### "Coach diagnoses a platform issue"

1. Coach detects a problem in a platform skill (e.g., `compose-skill` produced an invalid bundle).
2. Drafts a `platform_issue` proposal with `resolutionRoute: 'platform_issue'`.
3. Lands in `/coach/platform-issues/`.
4. Helmsman tells the operator "I diagnosed this but can't fix it from here" and summarizes.
5. Operator (or platform team) addresses it by editing `packages/platform-artifacts/src/skillBundles.ts` and redeploying.
