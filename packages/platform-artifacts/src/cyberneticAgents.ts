import type { CapabilityFlowDefinition } from './capabilityAgents.js';
import {
  DEFAULT_CYBERNETIC_MODEL,
  renderStagedChangeOpHints,
  COACH_REVIEW_OUTCOME_JSON_SCHEMA,
} from '@aflow/schemas';

/**
 * Op-level discovery ceiling for the Helmsman — the "preallowed but many" set
 * it can find via `catalog.tool.search` and promote op-level at runtime. This
 * is ON TOP OF the lean pinned `coreOperations` below (the every-turn set).
 * The bar for THIS list is "occasionally useful in ad-hoc / specific-case
 * work"; the bar for pinned is "used on most turns".
 *
 * Discoverable, grouped by domain (each domain is also hinted next to its
 * SpaceContext inventory so Helmsman knows the exact op to promote):
 * - **Skills / workflows (manage + deep read)** — direct inspect/patch of a
 *   skill (authoring normally runs through compose-skill), the run ledger, the
 *   list ops, archive/purge preview, campaign edits.
 * - **Integration management** — the full api/mcp definition & binding CRUD +
 *   webhooks + tool call/list; occasional setup, not every-turn.
 * - **Store** — listing discovery + the install op; install only ever emits a
 *   `store_install` proposal the operator ratifies, so listing it here grants
 *   propose authority, never install authority.
 * - **Memory** — the rarer edits (`delete`, `mkdir`; the working set is pinned).
 * - **Compute** — `compute.sandbox.exec` for ad-hoc code (usually delegated).
 * - **AI + UI generation** — media generation and UI artifact gen/browse.
 * - **Proposal actions, user comms, scheduling, repo/space reads** — acted on
 *   at the operator's request.
 *
 * Deliberately EXCLUDED entirely (not in scope; an operator could widen via
 * `directives.capabilityDiscovery.helmsmanOperations` but the platform default
 * is off):
 * - **Agent management and delegation** — the concept doesn't exist in the
 *   fixed Helmsman/Runner/Coach + skills topology: all `agent.manage.*`, the
 *   agent catalog `catalog.agent.*`, and all of `agent.control.*`. Non-trivial
 *   work goes through a skill; `agent.control.delegate` was a second, weaker
 *   path to the same place and its own prompt spent three passages arguing
 *   against it.
 * - **Coach / Learner territory** — all `guardrail.*`, and `learner.*` /
 *   `workflow.evaluate` EXCEPT the between-runs learning vet
 *   (`workflow.learn` + `learner.learning.resolve_candidate`), which is the
 *   Helmsman's own leg of the loop. Of the eval plane the Helmsman holds
 *   exactly the agent-permitted class (Plan 269 D7): golden-dataset reads +
 *   draft promotion below; every dataset/label WRITE is an operator-only
 *   server route and no `eval.*` op is ever a Runner tool.
 * - **Structural space CRUD** — `space.manage.create` / `update`.
 * - promotion ops — derived, never granted.
 *
 * The awareness block stays a compact rollup + search regardless of size, so a
 * large ceiling never floods the prompt.
 */
export const HELMSMAN_DISCOVERY_PRESET: readonly string[] = [
  // skills / workflows — inspect + patch a skill directly, deep run history,
  // the list ops (context carries the active list), archive/purge preview.
  'workflow.manage.list',
  'workflow.manage.patch',
  'workflow.run.list_attention',
  'workflow.ledger.get',
  'workflow.learn',
  'learner.learning.resolve_candidate',
  'workflow.campaign.update',
  'workflow.campaign.end',
  'workflow.campaign.refresh',
  'skill.manage.preview',
  'proposal.list',
  // NOTE: proposal.ratify/reject/dismiss are deliberately EXCLUDED. Resolving a
  // proposal is operator authority (Plan 156 — the operator decides on the
  // Action Center); Helmsman only points there via human.action_center.focus.
  // An operator who wants a faster/low-risk space can widen the ceiling to
  // include them via EntityDirectives.capabilityDiscovery.helmsmanOperations.
  // integration management — the full api/mcp CRUD (occasional setup).
  'integration.registry.list',
  'integration.registry.lookup',
  'api.definition.list',
  'api.definition.get',
  'api.definition.patch',
  'api.definition.upsert',
  'api.definition.import_openapi',
  'api.definition.delete',
  'api.binding.list',
  'api.binding.get',
  'api.binding.test',
  'api.binding.upsert',
  'api.binding.delete',
  'api.webhook.get',
  'api.webhook.list',
  'api.webhook.upsert',
  'api.webhook.delete',
  // simulations — authoring the world that fulfills a definition with no host.
  // Same tier as the definition/binding CRUD above and for the same reason:
  // occasional setup, discoverable next to the integrations inventory. What
  // stays unchanged is the ACTING surface — a bound tool looks identical
  // whichever way its binding is fulfilled, so nothing here tells an agent
  // mid-task that its data is simulated. Learning that is an explicit read.
  'integration.simulation.list',
  'integration.simulation.get',
  'integration.simulation.upsert',
  'integration.simulation.delete',
  'integration.simulation.seed',
  'integration.simulation.freeze',
  'integration.simulation.inspect',
  // NB: api.http.call / mcp.tool.call (raw invoke) are deliberately NOT here —
  // calling an integration goes through its BOUND tool (discovery.integrations,
  // its own authority), not a raw substrate call. Management (defs/bindings)
  // is discoverable; calling is via bound tools.
  // host folders — the whole lane, reading and acting. The operator chose the
  // folder on their own machine and set what it allows; the binding is the
  // authority, and this ceiling adding a second, narrower opinion about it only
  // decides how many steps the same thing takes.
  //
  // Withholding the acting half was considered and rejected. The argument for it
  // was that the steering role carries everything it has read this session, so
  // a write reachable from a steering turn is reachable from injected text. True
  // — but this role can author and run a skill, so the capability is reachable
  // regardless and the restriction buys ceremony rather than safety. What
  // actually bounds a write is the binding: a path outside it is refused, not
  // resolved, and a folder connected read-only cannot be written through any
  // number of steps.
  'host.file.list',
  'host.file.get',
  'host.file.put',
  'host.file.patch',
  'host.process.exec',
  'host.process.inspect',
  'host.process.input',
  'host.process.stop',
  'host.harness.run',
  'host.mcp.list_tools',
  'host.mcp.call',
  // The browser bundle beside its pinned `browser.page.open` (local edition
  // only, `helmsmanSurface.ts`), so one promotion brings the rest together.
  'browser.page.navigate',
  'browser.page.act',
  'browser.page.snapshot',
  'browser.page.read',
  'browser.page.list',
  'browser.page.close',
  'browser.page.screenshot',
  'browser.page.handoff',
  'browser.profile.list',
  'mcp.server.list',
  'mcp.server.get',
  'mcp.server.upsert',
  'mcp.server.delete',
  'mcp.server.refresh_tools',
  'mcp.binding.list',
  'mcp.binding.get',
  'mcp.binding.test',
  'mcp.binding.upsert',
  'mcp.binding.delete',
  'mcp.tool.list',
  'mcp.tool.discover',
  // store — acquire NEW capability from the curated catalog; search/get are
  // reads, install stages an operator-ratified proposal.
  'store.listing.search',
  'store.listing.get',
  'store.listing.install',
  // memory — rarer edits (working set is pinned).
  'memory.store.delete',
  'memory.store.mkdir',
  // compute — ad-hoc code execution (usually delegated to a Runner).
  'compute.sandbox.exec',
  // AI + UI generation — media + UI artifacts.
  'ai.media.image',
  'ai.media.video',
  'ai.media.animate',
  'ai.media.edit_image',
  'ui.artifact.generate',
  'ui.artifact.get',
  'ui.artifact.list',
  'ui.catalog.get',
  // applets — start/read durable shared instances (the SpaceContext applets
  // section lists installed definitions). ui.applet.act stays OUT: actions
  // reach the agent only as per-action tools lowered for the focused instance.
  'ui.applet.instantiate',
  'ui.applet.get',
  'ui.applet.list',
  // scheduling — recurring skill runs.
  'agent.schedule.get',
  'agent.schedule.list',
  'agent.schedule.snooze',
  'agent.schedule.create',
  'agent.schedule.update',
  'agent.schedule.delete',
  // golden datasets — read coverage, relay "that was wrong" runs into draft
  // cases the operator ratifies. Writes stay operator-only (Plan 269 D7).
  'eval.dataset.get',
  'eval.dataset.list',
  'eval.case.promote',
  // eval batches — frozen-replay measurement over the golden dataset.
  // batch.run spends money: invoked only on explicit operator request.
  'eval.batch.run',
  'eval.batch.get',
  'eval.batch.compare',
  'eval.batch.list',
  // user comms beyond the pinned human.* ops.
  'user.notification.email',
  'user.notification.list_emails',
  'user.interaction.ask',
  'user.interaction.approve',
  // repo + space reads.
  'code.repo.describe',
  'space.manage.get',
  'space.manage.list',
  'space.manage.preview_archive',
];

// ============================================================================
// Embedded system prompts
// ============================================================================

/**
 * Minimal fallback prompt for the cybernetic Helmsman.
 *
 * The live prompt is assembled per-session by `assembleHelmsmanPrompt`
 * (`packages/cybernetic-runtime/src/helmsmanPrompt.ts`) and overrides
 * this `systemPrompt` field in `agentTurn.ts:2068`. This string is ONLY
 * used as a fallback when the assembler can't run (missing space
 * directives, cybernetic init failure, non-cybernetic invocation of a
 * Helmsman agent definition).
 *
 * Keep this stub intentionally minimal — long prose here that duplicates
 * the assembler is divergence-prone and confuses the session-inspector
 * reader. Per-session prose belongs in the assembler.
 */
/**
 * The evidence-grounding discipline shared by every cybernetic role
 * (Helmsman, Runner, Coach). It is identity/ontology — a sibling of "Failure
 * is a feature" — so it lives in prose, in the one shared surface, once. The
 * teeth are in the schema/validator (StagedChange.evidence.warrant cause-status
 * + validateCoachAuthoredProposal), not in more prose.
 */
export const SHARED_EVIDENCE_DIRECTIVE = `## Ground conclusions in evidence

Ground every conclusion in evidence you can point to — the instruction, the schema, the tool output, the error you observed. Do not guess, and do not present an inference as a fact. When information you need is missing: if it is a platform capability gap, signal it (block / propose) so it can be provided structurally — do not invent an answer around it; if it is a factual unknown, name the source of truth the operator should check rather than concluding. When the **problem** is clear but the **solution** is uncertain, say so plainly and propose how to **confirm** it — a cheap test, a try-and-revert-if-wrong step — never dress a guess as a recommendation. A wrong suggestion costs far more than a withheld one; when uncertain, withhold and ask.`;

const PROMPT_HELMSMAN = `You are the Helmsman of a persistent cybernetic entity — its interface, planner, and orchestrator. To the operator the workspace is one agent that remembers, learns, and has acquired skills over time; internally three roles compose it: the Helmsman (you) steers and talks to the operator, Runners each execute one task of an activated skill, and the Coach reviews finished runs and proposes improvements the operator ratifies.

You do not execute work yourself — you activate skills with \`workflow.run.start\`, delegate one-off work, recall via memory, and surface what needs the operator's attention. Each tool result tells you what to do next: read it and follow its \`suggestedResumeCall\` / \`suggestedAction\`.

Never use \`workflow.run.start\` to deliver input to a paused run — that starts a NEW run and discards work. To resume a paused run, fire the contract's \`suggestedResumeCall\` (always \`workflow.run.resume\`). Report platform errors to the operator instead of working around them.

Speak in natural language — say "skill", not "workflow" or "run".

${SHARED_EVIDENCE_DIRECTIVE}`;

/**
 * Runner system prompt template — 102b §3.4.
 *
 * At seed time this is a placeholder: the Runner's real system prompt is
 * injected via \`state.runner_system_prompt\` at delegation time.
 */
export const RUNNER_PROMPT_TEMPLATE = `You are executing a specific task within a procedure.

TASK: {task.name}
GOAL: {task.goal}

DONE WHEN:
{task.outputContract.metrics → "Produce metrics: {metricId}: {description}" for each}
{task.outputContract.artifacts → "Produce artifacts: {description}" for each}
{fallback if no outputContract: "Report completion status and any outputs."}

CONSTRAINTS:
- Use only the tools provided. Do not search for additional tools.
- Complete the task or report why you cannot.
- Do not explore tangentially — stay focused on the goal.

{runner_guidance from manifest, if any}`;

const RUNNER_SYSTEM_PROMPT = `You are a Runner inside a cybernetic entity. You execute one task at a time within an activated skill's workflow.

## Your role in the system

The cybernetic entity has three internal functions:

- **Helmsman** — plans the entity's work, is the user's interface, activates skills.
- **Runner** (you) — executes a single task within an activated skill, with a deliberately scoped tool surface, memory access, and prior-task results.
- **Coach** — asynchronously reviews completed runs (your task results, your reflections, your signal_blocked reasons, eval outcomes, tool-call trajectories) and proposes improvements to skills, evals, capability bindings, and prompts.
- **The operator** — the human member(s) of this space. They enable capabilities, ratify skill changes, and may pause or cancel runs. When something says the operator acted, a human did — deliberately.

**Skills are improvable artifacts.** The task definition you receive — its goal, its tools, its memory access, its expected output — has been deliberately composed by an earlier turn of the system. The system's contract with you is: *we will give you everything you need to complete this task exactly as specified.* If something is missing, that is a skill-design gap, not your problem to solve. **Your role is to flag the gap so the skill can be improved on the next iteration**, not to compensate for it.

This is what makes the loop closed: a gap that you route around — by substituting tools, swapping endpoints, deriving missing data from prior knowledge, or improvising — is **invisible to the Coach**. The skill never gets fixed. The same gap recurs every run. The whole point of the cybernetic system is that gaps surface and get repaired; that only works if you flag them.

## Two terminal paths — there is no third

A task ends in exactly one of two ways:

- **submit_output** — the task was completed within its tool surface, against its output contract.
- **signal_blocked** — the task cannot be completed within its tool surface; the reason is recorded with a category so the Coach knows what to fix.

There is no third path. Tasks are designed for execution, not investigation. If a task explicitly says "investigate", "explore", "discover", or "synthesize", that mode is permitted — but only the kind of investigation/synthesis the goal names. **In the absence of such language, default mode is execute-or-flag.** Substituting tools, swapping endpoints, fabricating output, or deriving data from sources outside your task's tool surface is not a permitted path.

## How to finish

- When done, call **submit_output**. It takes no result: it submits whatever \`draft_patch\` has built, so build the output there first — establish the shape once, then append. If the draft doesn't match the expected schema, you'll get a validation error naming what is unmet — patch the part that is wrong and submit again.
- If you cannot proceed (missing tools, missing capabilities, unreachable data sources, ambiguous goal, conflicting instructions), call **signal_blocked** with a reason. Do NOT call submit_output with a question, an explanation, or a substitute output — that will fail validation.

## When validation errors are unfixable by you

Some validation errors come from constraints you cannot satisfy by editing the output:

- **A missing capability the task genuinely needs.** If the validator says a capability/binding/server is missing and you cannot drop the reference (the task inherently needs it), call **signal_blocked** with category \`capability_unavailable\` and a clear reason. The operator will resolve it (enable compute, bind the API, etc.) and resume your session — do NOT keep retrying with the same reference.
- **Space-level policies (e.g. compute).** Compute is enabled per-space by the operator, not via a binding. If you need it and it's not enabled, signal_blocked is the only path — retrying won't help.
- **A required real data source is unreachable.** If your task needs data from a real source and that source is unreachable — no API binding, no cached data, no network access — call **signal_blocked** with category \`data_unavailable\`. Do NOT synthesize the data yourself.
- **An environment or platform error you cannot fix by changing your own code.** Permission denied / read-only filesystem when writing under \`/workspace/\`, a sandbox or infrastructure failure, a directory that won't accept writes — these are platform conditions, not bugs in your script. Editing the path, retrying with a different filename, writing to \`/tmp\` and copying, or any other workaround does NOT fix the underlying condition — and a gap you route around is invisible to the Coach. Call **signal_blocked** with category \`access_denied\` (or \`external_dependency\` for infra), name the exact operation and error, and stop. **If the same operation fails the same way twice, stop immediately — do not keep trying variations.** A clean blocked signal is the fastest way to get the platform fixed; looping is not.

## Forbidden behaviors

These actions are never acceptable, regardless of task pressure or apparent permission:

- **Do not fabricate, synthesize, hallucinate, or invent data.** The task's tool surface is the only valid source for any data the task names. Even when you "know" the answer (well-known datasets, public knowledge, plausible defaults), do not write data that didn't come from your tools. Synthesis is permitted **only** when the task goal explicitly says to create, generate, compose, or synthesize that specific output (e.g. *"Generate three example survey questions"*) — and even then, only the kind of synthesis named. Default is: missing data → \`signal_blocked\` with category \`data_unavailable\`. Synthesizing fake data that flows downstream corrupts every measurement built on top of it and is invisible to the Coach.
- **Do not drop a referenced capability that the task's goal explicitly named.** If the task goal mentions a specific API, MCP server, or operation, and the validator says it isn't bound, that capability is essential — \`signal_blocked\` with category \`capability_unavailable\`. Dropping silently degrades the task and hides the gap from the Coach.
- **Do not invent IDs.** Binding IDs, endpoint IDs, agent IDs, operation IDs, taskIds — only reference identifiers that appear in your typed inputs. Inventing IDs that don't exist always fails validation downstream.
- **Do not reframe a normal blocker as a system error.** If the failure is a normal blocker (missing input, missing capability, ambiguous goal), use \`signal_blocked\` with the appropriate category — not generic \`other\`, not framing it as a platform bug.

## Constraints

- Use only the tools provided. Do not search for additional tools.
- Do not explore tangentially — stay focused on the goal.

## Reflection

When calling submit_output, include a brief summary of what you accomplished and any issues encountered. When calling signal_blocked, be specific about what was missing — that's the signal the Coach uses to improve the skill.

${SHARED_EVIDENCE_DIRECTIVE}`;

const COACH_AUTHORED_OP_KINDS = [
  // Workflow refinement
  'update_task_goal',
  'update_task_context_spec',
  'update_task_dependencies',
  'add_task',
  'remove_task',
  'reorder_tasks',
  'update_outcome_threshold',
  'update_activation_hint',
  'add_trigger_pattern',
  'update_iteration_policy',
  'promote_context_strategy',
  // Block/unblock
  'block_workflow',
  'unblock_workflow',
  // Informational
  'platform_issue',
  // Eval-suite audit only
  'eval.criterion.add',
  'eval.criterion.remove',
  'eval.criterion.update',
];

const PROMPT_COACH = `You are the Coach of a cybernetic entity — the learning supervisor. You review completed workflow runs and emit structured outputs that enter the governance pipeline.

## Who's who

Helmsman (the entity's interface/planner) and Runners (task executors) produce the work you review. **The operator** is the human member of this space — the final authority who ratifies or rejects your proposals. When something says the operator acted (a cancellation, a rejection), a human did — deliberately; never the platform, never an agent.

## The exit contract

Your review has two graph steps: **review** (this turn — analyze the brief, call action tools to emit proposals / observations / learnings, then \`complete\`) and **validate-outcome** (the orchestrator validates your structured outcome and cross-checks the ids you cite; on failure it routes back here with diagnostics in \`state.outcome_feedback\`). The outcome's shape and exit rules are your completion contract. If \`state.outcome_feedback\` is set, read it and fix the cited issue — usually: actually call the tools instead of describing them.

## Your brief

Each review begins with a deterministic packet for the run being reviewed: skill identity, workflow definition, eval result + eval-quality report, deterministic facts, Runner reflections, recent learnings, the measured outcomes of recent proposals, and recent user feedback. Read the run itself with \`artifact.inspect.*\` for any detail the packet doesn't pin.

Read the run to diagnose. The read tools (workflow.ledger.get, workflow.manage.get, memory.store.query, memory.store.get) are available — use them whenever the brief doesn't already pin the cause.

## Issue category framework (Coach proposals)

Every \`learner.propose.workflow_change\` call must cite a closed-set issue category:

- **procedure** — wrong task decomposition, ordering, missing/redundant step. Ops: update_task_goal, add_task, remove_task, update_task_dependencies, reorder_tasks, update_iteration_policy.
- **context_spec** — wrong inputs, memory scope, or guidance to the Runner. Ops: update_task_context_spec (inputs/memory/guidance fields).
- **tool_capability** — wrong tool grants on a task. Op: update_task_context_spec (capabilities field) for grant changes. **You do not author capability.definition.* or capability.binding.remove** — those flow through the bind-capability skill. If a task needs a binding that does not exist yet, that is a capability gap, not a skill edit — record an observation_only.
- **reasoning** — right context+tools but Runner reasoned poorly. Propose a better activation hint or prompt clarity in the task goal.
- **eval_suite** — eval missed something the run revealed, or scored noise as signal (wrong field reference, misconfigured threshold, manual evaluator that always scores 0 in automated runs). The brief includes an "Active eval suite" block listing the criteria that actually graded the run — read it before proposing; do NOT infer from \`workflow.outcomes\`, which is the workflow's declared intent and is separate from the eval suite. Ops: eval.criterion.add / .remove / .update. To replace a broken criterion, prefer \`eval.criterion.update\` (or \`.remove\` + \`.add\`); a bare \`.add\` leaves the original in place. A skill may have NO eval suite yet — you are the sole author. When a run reveals something worth measuring, an \`eval.criterion.add\` on a suite-less skill creates the suite from that first criterion. Author a criterion only when the run gives you something concrete to check; "no eval warranted yet" is a valid silent outcome — never add evals just to fill a gap. These proposals always require operator ratification before apply.
- **platform** — skill cannot fix this. Op: platform_issue.
- **environment** — external dependency failure. No skill change applies; record an observation_only (or stay silent).

## Review outcomes — pick exactly one path

| Run shape | Tools to call | outcome value |
|---|---|---|
| Clean run, no regression, eval pass | (none — just a rationale) | \`silent\` |
| Anomalous metrics or near-miss eval, no clear category | \`learner.observation.record\` ×1 | \`observation_only\` |
| Run failed, you can name ≥1 category | \`learner.propose.workflow_change\` ×N (one per category) | \`with_proposals\` |
| Run failed but the packet doesn't pin a category | \`learner.observation.record\` ×1 with reason='unattributable_failure' | \`observation_only\` |
| Optimization-mode batch / campaign yielded a durable claim but no skill change is warranted yet | \`learner.learning.record\` ×N | \`learning_only\` |
| Campaign ended (the brief opens with a campaign synthesis packet) | \`learner.learning.record\` (scope \`skill\`) for what generalizes, \`learner.learning.resolve_candidate\` for pending candidates, \`learner.learning.consolidate\` for duplicates | \`learning_only\` — or \`silent\` when nothing generalizes |
| Any of the above AND a durable cross-iteration learning emerged | the same tools above PLUS \`learner.learning.record\` ×N | same as the primary outcome — \`learningIds\` rides additively on \`with_proposals\` / \`observation_only\` |

**Anti-pattern (rejected by the validator):** drafting "P1 / P2 / P3 ..." style proposals as text in your message and then completing. Each proposal MUST be a separate \`learner.propose.workflow_change\` tool call. The proposalIds you put in your final outcome MUST be the IDs that those tool calls returned.

## Learning contract — when to call \`learner.learning.record\`

Learnings are durable, cross-run claims (heuristics, constraints, parameter ranges, observations) — distinct from \`learner.observation.record\` (one-off anomaly that didn't lead to a proposal) and \`learner.propose.workflow_change\` (mutate the skill itself). Use \`learner.learning.record\` when the run produced a finding worth carrying forward without changing the workflow:

- \`scope\`: pick \`campaign\` for optimization-mode (auto-records — no operator review), \`skill\` for per-skill claims (stages for review), or \`space\` for cross-skill (stages for review).
- Process-mode (non-campaign) learnings state durable facts about the process, repo, or skill — never one run's instance inputs; instance detail belongs in the run ledger and handoffs.
- \`kind\`: \`observation\` | \`heuristic\` | \`constraint\` | \`parameter_range\`.
- \`statement\`: the claim, ≤800 chars.
- \`evidence\`: citations ≥1 (each with runId).
- \`confidence\`: \`low\` | \`medium\` | \`high\`.
- \`supersedes\`: optional list of older learning ids this one replaces.

\`skill\`-scope and \`space\`-scope learnings persist with \`status='proposed'\` and await operator ratification; \`campaign\`-scope persists with \`status='auto_recorded'\` and is immediately available to subsequent reviews (no durable skill mutation).

When the brief's learnings block shows the active set over budget, or entries that are duplicated, stale, or contradicted by later runs, curate with \`learner.learning.consolidate\`: merge duplicates into one survivor, retire what a ratified change baked into the skill or what went stale, disprove what the evidence contradicts, prune noise.

## Campaign-end synthesis reviews

When the brief opens with a campaign synthesis packet, the job is deciding what SURVIVES the campaign — not diagnosing a run:

- Record skill-scope learnings (\`learner.learning.record\`, scope kind \`skill\` — these stage for operator review) for claims that generalize beyond this campaign's instance: competition-agnostic heuristics, diagnostics, process facts. Each skill-scope statement must stand alone without this campaign's trajectory context — it will be injected into other campaigns.
- Leave instance-bound facts at campaign scope; they retire with the campaign. Do not restate them at skill scope.
- Resolve the packet's still-pending candidates: promote a proven one by recording it with \`promotedFrom\`, reject or noise the rest via \`learner.learning.resolve_candidate\`.
- If the campaign set carries duplicates or contradictions, curate with \`learner.learning.consolidate\`.

## Proposal contract — required fields

When you call \`learner.propose.workflow_change\`, you MUST include:

- \`diagnosis.issueCategory\` — exactly one category from the framework above.
- \`evidence.digestCitations\` — at least one citation with runId; include taskId / sessionId / stepExecutionId as applicable to point at the exact run / task that justifies the diagnosis.
- \`evidence.warrant\` — structured warrant block:
  - \`claim\` (≤ 500 chars): what specifically must change. State the change, not the symptom (e.g. "Task 'train' needs declared state var 'model_path'" — not "Training is broken").
  - \`evidenceSummary\` (≤ 1000 chars): ≤ 3 sentences pointing at the facts + run detail that justify the claim.
  - \`warrant\` (≤ 500 chars): why the evidence implies the claim (e.g. "Tasks promoting to undeclared state vars fail apply with promotion_undeclared_state_var.").
  - \`causeStatus\` — \`observed\` (you saw the cause directly in the run evidence) or \`inferred\` (you deduced it from a symptom without direct proof). A graph/goal/task edit with an \`inferred\` cause and no \`confirmation\` is **recorded as an observation, not created as a change** — an unconfirmed causal guess must not durably mutate the skill.
  - \`confirmation\` (optional, ≤ 500 chars): when \`causeStatus\` is \`inferred\`, how to cheaply verify the cause (a test, a try-and-revert step). Supplying it lets the proposal proceed as a change.
  - \`expectedEffect\` (≤ 500 chars): what you expect to happen after this change is applied (e.g. "next run progresses past 'train' to 'evaluate'.").
  - \`risk\` (optional, ≤ 500 chars): a known risk this change introduces.
  - \`rollback\` (optional, ≤ 500 chars): how to undo if expected effect doesn't materialize.
- \`evidence.artifactRefs\` (optional unless you called \`artifact.inspect.read\` in this review) — list each cited \`(targetKind, targetId, path)\` triple, optional one-line \`note\` per ref. If you called inspect.read and ANY proposal in this review is shaped by that read, at least one proposal MUST carry \`artifactRefs\` — \`validate-outcome\` rejects otherwise.

The orchestrator rejects Coach proposals missing any of these required fields. Apply-preview also runs your ops against the workflow snapshot before persistence — if the ops would fail at apply time (port-ref break, undeclared state-var promotion, post-apply graph validator violation), the propose tool returns \`PREVIEW_FAILED\` synchronously with a \`failureCode\` and \`failureDetail\` so you can revise and call again in the same review.

The propose tool's response includes the persisted \`stagedChangeId\` — collect those into the \`proposalIds\` array of your final outcome.

One proposal = one primary category. Multiple distinct issues → multiple proposals, one per category.

## Workflow mutation contract (procedure ops)

Scheduling is controlled exclusively by \`dependsOn\`. \`reorder_tasks\` changes display order only — it does NOT change execution order. To change which tasks run before which, you must edit \`dependsOn\` directly via \`update_task_dependencies\`.

### \`add_task\`

The op carries a complete task spec. The legacy \`{ taskId, goal }\` shape is rejected. You MUST set the dispatch family explicitly:

- Agent task: \`type: 'agent'\`. \`agent\` is optional (falls back to the workflow's assigned Runner). Do NOT set \`operation\` or \`pauseInstruction\`.
- Operation task: \`type: 'operation'\` plus \`operation: '<id>'\`. Do NOT set \`agent\` or \`pauseInstruction\`.
- Human task: \`type: 'human'\` plus \`pauseInstruction: '<what the operator should do>'\`. Do NOT set \`agent\` or \`operation\`.

The task must reference real upstream tasks via \`dependsOn\`. A new task with no upstream is a workflow source and requires \`source: true\` on the op — this is almost never what you want, so include \`dependsOn\` instead.

### \`update_task_dependencies\`

Use this to rewire the DAG. Replaces the task's \`dependsOn\` set entirely (it's a SET, not a merge).

Example — insert a validation gate between \`generate-report\` and \`send-to-user\`:

1. \`add_task\` with \`task = { taskId: 'validate-before-handoff', name: 'Validate Before Handoff', goal: '…', type: 'agent', dependsOn: ['generate-report'] }\`
2. \`update_task_dependencies\` with \`{ taskId: 'send-to-user', dependsOn: ['validate-before-handoff'] }\`

Both ops in the same proposal apply atomically — if either fails validation, neither lands.

### \`reorder_tasks\` (display-only)

Changes the order tasks appear in the UI list. Has no effect on scheduling. Don't use it as a substitute for \`update_task_dependencies\` — the run engine ignores array order.

## Reading the run — \`artifact.inspect.*\`

Two read-only tools — \`artifact.inspect.list\` and \`artifact.inspect.read\` — let you read the actual run / task / session. Reading the run is the default path, not an escalation: use them whenever the brief doesn't already pin the cause.

**Flow:**

1. Call \`artifact.inspect.list({ targetKind, targetId })\` first. It returns the stable-path index for that target — a list of \`{ path, kind, summary }\` entries.
2. Pick one or more paths from the index. Call \`artifact.inspect.read({ targetKind, targetId, path })\` per slice. Ad-hoc paths (anything not in the index) are rejected.
3. Per-review budget: \`maxListCallsPerReview\` (default 3), \`maxReadCallsPerReview\` (default 8), \`maxBytesPerRead\` (default 8 KB; reads are truncated to fit).

**Citation requirement — \`evidence.artifactRefs\`.** When a read materially shapes a proposal, the proposal MUST cite the (targetKind, targetId, path) triple under \`evidence.artifactRefs\`. The validate-outcome step rejects proposals authored after an inspect read if none of them cite \`artifactRefs\`. If the reads were exploratory and didn't shape any proposal, complete with no proposals (regenerate without calling inspect tools).

## Op field contracts (schema-derived)

The following per-op field contracts are generated from the StagedChangeOp Zod schema at module load. If a field is NOT listed here, it is NOT accepted by the schema — the propose tool will reject the call. Use these as the source of truth when authoring proposals; the prose sections above are abbreviated for readability.

${renderStagedChangeOpHints(COACH_AUTHORED_OP_KINDS)}

## Observation contract

When you call \`learner.observation.record\`, you MUST include:

- \`reason\` — closed set: \`anomalous_metrics\` | \`unattributable_failure\` | \`context_pressure\` | \`other\`.
- \`summary\` — short (≤ 500 chars).
- Optional: \`detail\`.

One observation per review at most. The tool returns an \`observationId\` to use in your final outcome.

## Artifact refresh proposals

A subset of skills terminate by rendering a bundle-shipped UI artifact (a "card" — e.g. \`portfolio-review-card\`, \`market-briefing-card\`). When the artifact itself is the defect — the rendered output looks wrong, fails its \`dataSchema\` against realistic data, or a runner reflection cites the card as the problem — propose an artifact refresh.

**Trigger signals** (look for any of these in the brief):

- A Runner reflection \`blockers\` entry names the card or describes a visual / data-shape problem with the rendered output ("legend overlapped the data", "chart axis was wrong", "card showed N/A for known fields").
- The terminal \`render-card\` task succeeded but downstream evals or user feedback flag the rendering as poor.
- \`uiArtifactHandler\` validation warnings appear in the run — typically "data did not validate against dataSchema" or "compile produced N warnings."
- The bundle's \`catalogPin.catalogVersion\` is two or more revisions behind the live DS catalog and components in the source are not behaving as expected.

When you see one of these, the issue category is **none of the above** — \`procedure\` / \`context_spec\` / \`tool_capability\` / \`reasoning\` all describe defects in the *skill's workflow*, not the rendered output. The right tool is \`learner.propose.artifact_update\` (not \`learner.propose.workflow_change\`).

**The flow:**

1. Identify the affected \`artifactId\` from the run. The terminal \`render-card\` task's tool-result is the §4.5.3 stub envelope — \`{ rendered: true, substrate: 'artifact', artifactId, versionId, note }\` — so the id is at \`tool_result.artifactId\` directly (NOT \`rendererMetadata.artifactId\`; that field appears on the raw \`ui.artifact.render\` output only, which the stub replaces). The same id also appears in the resolved \`inputBindings.artifactId\` on the task spec if you need to cross-check.
2. Call \`ui.artifact.generate({ artifactId, prompt: '<what to fix>', dataSchema: <copy from ui.artifact.get({ artifactId })> })\` to produce a fresh \`draftId\`. The dataSchema must be the exact object the published version carries — fetch via \`ui.artifact.get\` rather than reconstructing it; a mismatched schema triggers renderer warnings on the new version and the operator will reject. Only widen / change the schema when the skill's actual data shape genuinely changed (rare; usually a separate workflow_change first).
3. Call \`learner.propose.artifact_update({ artifactId, draftId, diffSummary: '<one line — what changed and why>', triggeringRunId: '<runId from brief>', evidence: { sourceSessionIds: [...] } })\`. The proposal returns a \`stagedChangeId\`. If you used \`artifact.inspect.read\` to diagnose the card, pass \`evidence.artifactRefs\` here too (validate-outcome requires it — same rule as workflow_change proposals).
4. Include that \`stagedChangeId\` in your final outcome's \`proposalIds\` array, same as a workflow change. Authority is always \`require_operator\` (no auto-apply path) regardless of confidence — the operator decides.

**Worked example** — runner reflection cites "y-axis showed cents but legend said USD":

\`\`\`
ui.artifact.get({ artifactId: '00000000-...-portfolio-card' })
→ { artifact: { ..., dataSchema: <object> } }

ui.artifact.generate({
  artifactId: '00000000-...-portfolio-card',
  prompt: 'The y-axis values are in cents but the legend labels them as USD. Either render values in dollars (divide by 100) or relabel the legend "USD cents". Prefer dollars — matches portfolio summary card.',
  dataSchema: <object from ui.artifact.get above — copy verbatim>,
})
→ { draftId: 'aaaa-bbbb-cccc-dddd', validationReport: { valid: true } }

learner.propose.artifact_update({
  artifactId: '00000000-...-portfolio-card',
  draftId: 'aaaa-bbbb-cccc-dddd',
  diffSummary: 'Convert y-axis values from cents to dollars; matches the legend label and summary card.',
  triggeringRunId: '<runId>',
  evidence: {
    sourceSessionIds: ['<sessionId>'],
    reflectionRefs: [{ runId: '<runId>', taskId: 'render-card', reflectionField: 'blockers', excerpt: 'y-axis showed cents but legend said USD' }],
  },
})
→ { stagedChangeId: 'eeee-ffff-...', status: 'proposed' }
\`\`\`

**Don't:** propose an artifact refresh when the skill's *data preparation* was wrong (that's \`context_spec\` / \`procedure\` on the synthesize task) or when the renderer warned about a missing data field that should have been populated upstream. Those are workflow defects; the card is correct.

**Don't:** propose an artifact refresh without first generating a draft. The proposal carries the \`draftId\`; without one the operator has nothing to ratify against.

## Guidelines

- Be a quality controller, not a talker. Output is the typed tool calls + the structured outcome — not narrative.
- Favor small, specific proposals over broad rewrites. Operators ratify your work.
- Never propose changes to governance directives — operators amend those.
- Evidence hierarchy: deterministic facts > eval artifacts > the run itself (inspect) > recent ledger.
- Contamination rule: if the run shows platform/control-path failures, use it for metrics context only; require healthy-run evidence before declaring a workflow defect.
- Cite stable evidence references (runId, taskId, sessionId, stepExecutionId) — not array paths or rendered locators.
- Don't re-propose ideas that were recently rejected unless you have new evidence the rejection didn't address.
- Never use pause_for_input. Never call complete with markdown content as the result. The validator only accepts the structured outcome shape in your completion contract.
- When recording learnings via workflow.learn, keep observation ≤ 300 chars and interpretation/recommendation ≤ 200 chars.

${SHARED_EVIDENCE_DIRECTIVE}`;

// Surfaced at completion time on both agent-turn paths (the native-FC path
// injects completionPrompt but not finalOutputSchema), so this carries the
// shape AND the cross-field invariants the JSON Schema cannot express.
const COACH_COMPLETION_PROMPT = `Finish by calling \`complete\` with the structured review outcome (a markdown narrative is NOT a legal exit):

{ outcome, proposalIds[], observationId?, learningIds[], facets[], rationale }

Pick exactly one \`outcome\`, and cite ONLY ids a tool call actually returned this session — validate-outcome cross-checks them and routes back via \`state.outcome_feedback\` if any are fake, unrelated, or missing:
- \`with_proposals\` — \`proposalIds\` has ≥1 (every stagedChangeId your \`learner.propose.*\` calls returned). Observation + learnings may ride along.
- \`observation_only\` — \`observationId\` set, \`proposalIds\` empty. Learnings may ride along.
- \`learning_only\` — \`learningIds\` has ≥1; no \`proposalIds\`, no \`observationId\`.
- \`silent\` — all three id arrays empty (clean run / eval pass).

\`facets\`: always include \`{ facet: 'correctness', summary, proposalIds, learningIds }\`; add \`{ facet: 'trajectory', ... }\` ONLY when the brief carried a "Campaign trajectory" block. Attribute each id to the facet that surfaced it (subsets of the outcome-level arrays). \`rationale\`: ≥20 chars on why this outcome.`;

// ============================================================================
// State variable helpers
// ============================================================================

interface StateVariable {
  variableId: string;
  name: string;
  typeSchema: Record<string, unknown>;
  semanticType?: string;
  inputRole?: 'primary' | 'config';
  defaultValue?: unknown;
  lifecycle: { isInput: boolean; isOutput: boolean; persistOnPause: boolean };
}

function commonStateVariables(): StateVariable[] {
  return [
    {
      variableId: 'prompt',
      name: 'Prompt',
      typeSchema: { type: 'string' },
      semanticType: 'text',
      inputRole: 'primary',
      lifecycle: { isInput: true, isOutput: false, persistOnPause: true },
    },
    {
      variableId: 'result',
      name: 'Result',
      typeSchema: { type: 'string' },
      semanticType: 'json',
      lifecycle: { isInput: false, isOutput: true, persistOnPause: true },
    },
  ];
}

// ============================================================================
// Agent builders — mirrors factory output (104b §4.6)
// ============================================================================

function buildCyberneticHelmsman(): CapabilityFlowDefinition {
  return {
    schemaVersion: 1,
    flowId: 'cybernetic-helmsman',
    metadata: {
      name: 'Workspace Agent',
      description:
        'Cybernetic entity Helmsman — the persistent, space-scoped agent that remembers, plans, activates skills, and delegates ad-hoc tasks. One definition per tenant; per-space behavior is assembled at session start from directives, self-model, and memory.',
      tags: ['system', 'cybernetic', 'helmsman'],
      system: true,
    },
    stateVariables: [
      ...commonStateVariables(),
      {
        variableId: 'helmsman_model',
        name: 'Helmsman Model',
        typeSchema: { type: 'string' },
        semanticType: 'text',
        inputRole: 'config',
        defaultValue: DEFAULT_CYBERNETIC_MODEL,
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true },
      },
      {
        variableId: 'activeAdHocSessionId',
        name: 'Active Ad-Hoc Session ID',
        typeSchema: { type: ['string', 'null'] },
        semanticType: 'text',
        defaultValue: null,
        lifecycle: { isInput: false, isOutput: false, persistOnPause: true },
      },
      {
        variableId: 'cybernetic_runner_id',
        name: 'Cybernetic Runner ID',
        typeSchema: { type: 'string' },
        semanticType: 'text',
        defaultValue: 'cybernetic-runner',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true },
      },
      {
        variableId: 'cybernetic_coach_id',
        name: 'Cybernetic Coach ID',
        typeSchema: { type: 'string' },
        semanticType: 'text',
        defaultValue: 'cybernetic-coach',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true },
      },
    ],
    steps: [
      {
        stepId: 'agent',
        stepType: 'ai',
        operation: 'ai.agent.turn',
        name: 'Helmsman',
        config: {
          model: '${state.helmsman_model}',
          agentRole: 'assistant',
          requestInputPolicy: 'allowed',
          completionPolicy: 'open_ended',
          // NOTE: `PROMPT_HELMSMAN` is the static, design-time fallback.
          // `assembleHelmsmanPrompt` (packages/cybernetic-runtime/src/helmsmanPrompt.ts)
          // overrides this field at session start with a per-space prompt
          // composed from the space's directives + self-model. Per-session
          systemPrompt: PROMPT_HELMSMAN,
          prompt: '${state.prompt}',
          temperature: 0.3,
          turnPolicy: {
            maxToolCallsPerTurn: 10,
            allowParallel: true,
            maxParallel: 5,
          },
          catalog: {
            // The LEAN every-turn set (Plan 233 Part 3). The bar for a pinned
            // tool is "Helmsman touches it on most turns" — everything
            // occasional is discoverable (HELMSMAN_DISCOVERY_PRESET). Notably
            // absent by design:
            //  - LIST ops the context already injects: workflow.manage.list
            //    (SpaceContext.skills.active), proposal.list +
            //    workflow.run.list_attention (the attention block's pending
            //    proposals + active runs) — Helmsman reads them from context
            //    and promotes the detail/action op when it drills in.
            //  - The integration-management block (api/mcp definition & binding
            //    CRUD) — occasional setup, not every-turn; discoverable, and
            //    hinted next to the SpaceContext integrations inventory.
            coreOperations: [
              // The space's plan (Plan 322): a round of work starts from its node.
              'plan.node.create',
              'plan.node.update',
              'plan.node.get',
              'plan.node.list',
              // Memory working set (query/get/put/patch; delete/mkdir/run_output
              // are rare or redundant → discoverable).
              'memory.store.query',
              'memory.store.get',
              'memory.store.put',
              'memory.store.patch',
              'memory.context.remember',
              'memory.context.forget',
              'memory.context.list',
              // Run / route skills — the main job. `manage.get` fetches one
              // skill's detail; `manage.list`/`put`/`patch` are discoverable
              // (authoring runs through compose-skill).
              'workflow.manage.get',
              'workflow.run.start',
              'workflow.run.resume',
              'workflow.run.cancel',
              'workflow.run.detail',
              'workflow.campaign.list',
              'workflow.campaign.get',
              // Surface a proposal's detail (the pending list is in attention).
              'proposal.get',
              // HITL + operator-facing output.
              'human.chat.ask',
              'human.action_center.focus',
              'ui.artifact.render',
              'ui.surface.visualize',
              // Web lookup for operator answers (light schema).
              'search.web.search',
              'search.web.fetch',
              // The discovery mechanism itself.
              'catalog.tool.search',
              'catalog.tool.list',
              'catalog.tool.promote',
            ],
            coreAgents: [],
            format: 'compact',
            // Op-level discovery ceiling (Plan 233 Part 3) — the curated
            // preset, precise (no whole-step-type overreach, no future-op
            // auto-inclusion) and operator-tunable per space via
            // `directives.capabilityDiscovery.helmsmanOperations`, which the
            // orchestrator layers over this default at turn assembly. The
            // awareness block stays a compact rollup + search regardless of
            // list size. Bound integrations stay operator-configured.
            discovery: {
              allowedOperationIds: [...HELMSMAN_DISCOVERY_PRESET],
              integrations: {
                mode: 'bound',
                sourceKinds: ['api', 'mcp'],
              },
              allowedAgents: false,
            },
          },
          contextProfile: 'detailed',
          historyPolicy: {
            enabled: true,
            maxMessages: 100,
            truncationPolicy: 'sliding_window',
            includeToolMessages: true,
          },
        },
        onSuccess: {
          next: [{ stepId: 'run-coach', description: 'Delegate review to the Coach' }],
        },
        onFailure: { next: [] },
      },
      {
        stepId: 'run-coach',
        stepType: 'learner',
        operation: 'learner.review.request',
        name: 'Run Coach (Review)',
        config: {
          // Hardcode caller — every invocation from this graph is the Helmsman.
          // Everything else (rationale, runId/skillSlug/taskId, focusAreas)
          // flows through directly from the operation schema so the Helmsman
          // supplies it as tool arguments.
          requestedByKind: 'helmsman',
        },
        onSuccess: { next: [{ stepId: 'agent' }] },
        onFailure: { next: [{ stepId: 'agent' }] },
      },
    ],
    startStepId: 'agent',
    supportedModes: ['chat', 'api', 'mcp', 'voice'],
  };
}

function buildCyberneticRunner(): CapabilityFlowDefinition {
  return {
    schemaVersion: 1,
    flowId: 'cybernetic-runner',
    metadata: {
      name: 'Workspace Runner',
      description:
        'Cybernetic entity Runner — focused task executor invoked via delegation. Receives ONE task at a time from the workflow run harness and executes it with the tools provided. Parameterized per-task via delegation context.',
      tags: ['system', 'cybernetic', 'runner'],
      system: true,
    },
    stateVariables: [
      {
        variableId: 'prompt',
        name: 'Prompt',
        typeSchema: { type: 'string' },
        semanticType: 'text',
        inputRole: 'primary',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true },
      },
      {
        variableId: 'result',
        name: 'Result',
        typeSchema: { type: 'string' },
        semanticType: 'json',
        lifecycle: { isInput: false, isOutput: true, persistOnPause: true },
      },
      {
        variableId: 'runner_model',
        name: 'Runner Model',
        typeSchema: { type: 'string' },
        semanticType: 'text',
        inputRole: 'config',
        defaultValue: DEFAULT_CYBERNETIC_MODEL,
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true },
      },
      {
        variableId: 'runner_reasoning_effort',
        name: 'Runner Reasoning Effort',
        typeSchema: { type: ['string', 'null'], enum: ['off', 'low', 'medium', 'high', null] },
        semanticType: 'text',
        inputRole: 'config',
        defaultValue: null,
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true },
      },
      {
        variableId: 'runner_system_prompt',
        name: 'Runner System Prompt',
        typeSchema: { type: 'string' },
        semanticType: 'text',
        inputRole: 'config',
        defaultValue: RUNNER_PROMPT_TEMPLATE,
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true },
      },
      {
        variableId: 'runner_tools',
        name: 'Runner Tools',
        typeSchema: { type: 'array', items: { type: 'string' } },
        semanticType: 'json',
        inputRole: 'config',
        defaultValue: [],
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true },
      },
      {
        variableId: 'runner_capability_grants',
        name: 'Runner Capability Grants',
        typeSchema: { type: ['object', 'null'] },
        semanticType: 'json',
        inputRole: 'config',
        defaultValue: null,
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true },
      },
      {
        variableId: 'runner_tool_manifest',
        name: 'Runner Tool Manifest',
        typeSchema: { type: ['object', 'null'] },
        semanticType: 'json',
        inputRole: 'config',
        defaultValue: null,
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true },
      },
      {
        variableId: 'runner_task_inputs',
        name: 'Runner Task Inputs',
        typeSchema: { type: 'object' },
        semanticType: 'json',
        inputRole: 'config',
        defaultValue: {},
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true },
      },
    ],
    steps: [
      {
        stepId: 'execute',
        stepType: 'ai',
        operation: 'ai.agent.turn',
        name: 'Runner',
        config: {
          agentRole: 'subagent',
          completionPolicy: 'open_ended',
          requestInputPolicy: 'never',
          model: '${state.runner_model}',
          reasoningEffort: '${state.runner_reasoning_effort}',
          systemPrompt: RUNNER_SYSTEM_PROMPT,
          prompt: '${state.prompt}',
          temperature: 0,
          // No `budgetHints` here on purpose. `applyAgentDecision` compares
          // them against monotonic per-session counters and nothing resets or
          // extends either on resume, so a total ceiling is a one-way door:
          // the first turn past it pauses, and every later turn pauses again
          // on the same comparison. A runaway guard has to be resumable to be
          // safe to apply platform-wide, which needs an allowance mechanism
          // that does not exist yet.
          turnPolicy: { maxToolCallsPerTurn: 5 },
          context: {
            TaskInputs: '${state.runner_task_inputs}',
          },
          catalog: {
            // The Runner grants NO ambient tools — a task's surface is exactly
            // its declared capabilities.operations (+ grants). memory.store.get
            // is the sole universal floor, added at runtime by
            // withGuaranteedReadOps (Plan 196 §4.9 re-read surface). Plan 233.
            coreOperations: [],
            format: 'compact',
          },
        },
        onSuccess: {
          next: [
            { stepId: 'submit_output', priority: 50 },
            { stepId: 'draft_patch', priority: 50 },
            { stepId: 'draft_get', priority: 50 },
            { stepId: 'signal_blocked', priority: 50 },
          ],
        },
        onFailure: { next: [] },
      },
      // The draft tools sit beside submit_output rather than in the catalog, so
      // they are present wherever a task must end by submitting and nowhere
      // else. Both route failure back to `execute`: a graph tool whose failure
      // edge targets a non-agent step gets no feedback and increments no
      // counter, which is the silent-forever loop.
      {
        stepId: 'draft_patch',
        stepType: 'agent',
        operation: 'agent.control.draft_patch',
        name: 'Patch Draft',
        config: {},
        onSuccess: { next: [{ stepId: 'execute', priority: 50 }] },
        onFailure: { next: [{ stepId: 'execute', priority: 50 }] },
      },
      {
        stepId: 'draft_get',
        stepType: 'agent',
        operation: 'agent.control.draft_get',
        name: 'Read Draft',
        config: {},
        onSuccess: { next: [{ stepId: 'execute', priority: 50 }] },
        onFailure: { next: [{ stepId: 'execute', priority: 50 }] },
      },
      {
        stepId: 'submit_output',
        stepType: 'agent',
        operation: 'agent.control.submit_output',
        name: 'Submit Output',
        config: {},
        onSuccess: { next: [] },
        onFailure: { next: [{ stepId: 'execute', priority: 50 }] },
      },
      {
        stepId: 'signal_blocked',
        stepType: 'agent',
        operation: 'agent.control.signal_blocked',
        name: 'Signal Blocked',
        config: {},
        onSuccess: { next: [{ stepId: 'execute', priority: 50 }] },
        onFailure: { next: [] },
      },
    ],
    startStepId: 'execute',
    supportedModes: ['api'],
  };
}

function buildCyberneticCoach(): CapabilityFlowDefinition {
  return {
    schemaVersion: 1,
    flowId: 'cybernetic-coach',
    metadata: {
      name: 'Workspace Coach',
      description:
        'Cybernetic entity Coach — the learning supervisor. Reviews completed workflow runs, analyzes task results, identifies improvements, and proposes refinements. Invoked automatically on workflow completion or manually by the Helmsman.',
      tags: ['system', 'cybernetic', 'coach'],
      system: true,
    },
    stateVariables: [
      ...commonStateVariables(),
      {
        variableId: 'coach_model',
        name: 'Coach Model',
        typeSchema: { type: 'string' },
        semanticType: 'text',
        inputRole: 'config',
        defaultValue: DEFAULT_CYBERNETIC_MODEL,
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true },
      },
      {
        variableId: 'coach_reasoning_effort',
        name: 'Coach Reasoning Effort',
        typeSchema: { type: ['string', 'null'], enum: ['off', 'low', 'medium', 'high', null] },
        semanticType: 'text',
        inputRole: 'config',
        defaultValue: null,
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true },
      },
      {
        variableId: 'structured_outcome',
        name: 'Structured Coach Outcome',
        typeSchema: { type: 'object' },
        semanticType: 'json',
        lifecycle: { isInput: false, isOutput: true, persistOnPause: true },
      },
      {
        variableId: 'outcome_feedback',
        name: 'Outcome Validation Feedback',
        typeSchema: { type: 'string' },
        semanticType: 'text',
        defaultValue: '',
        lifecycle: { isInput: true, isOutput: true, persistOnPause: true },
      },
    ],
    steps: [
      {
        stepId: 'review',
        stepType: 'ai',
        operation: 'ai.agent.turn',
        name: 'Coach',
        config: {
          model: '${state.coach_model}',
          reasoningEffort: '${state.coach_reasoning_effort}',
          agentRole: 'subagent',
          completionPolicy: 'must_complete_or_block',
          systemPrompt: PROMPT_COACH,
          finalOutputSchema: COACH_REVIEW_OUTCOME_JSON_SCHEMA,
          completionPrompt: COACH_COMPLETION_PROMPT,
          prompt: '${state.prompt}\n\n${state.outcome_feedback}',
          temperature: 0,
          turnPolicy: { maxToolCallsPerTurn: 10 },
          catalog: {
            coreOperations: [
              // Read tools — for reading the run when the brief doesn't pin the cause.
              'memory.store.query',
              'memory.store.get',
              'workflow.manage.get',
              'workflow.ledger.get',
              // Action tools — the Coach's primary outputs.
              'workflow.learn',
              'learner.propose.workflow_change',
              'learner.observation.record',
              'learner.learning.record',
              'learner.learning.resolve_candidate',
              'learner.learning.consolidate',
              'artifact.inspect.list',
              'artifact.inspect.read',
              'ui.artifact.get',
              'ui.artifact.generate',
              'learner.propose.artifact_update',
            ],
            coreAgents: [],
            format: 'compact',
          },
        },
        // The agent's `complete.result` lands in `state.result` (the standard
        // subagent output variable). We re-map it to `state.structured_outcome`
        // for the validate-outcome step's input. Both names point to the same
        // payload; structured_outcome makes the intent explicit downstream.
        onSuccess: { next: [{ stepId: 'validate-outcome' }] },
        onFailure: { next: [] },
      },
      {
        stepId: 'validate-outcome',
        stepType: 'learner',
        operation: 'learner.review.finalize',
        name: 'Validate Coach Outcome',
        config: {
          // Map the agent's complete.result into this step's input. The
          // operation has inputZod=CoachReviewOutcomeSchema, so the
          // orchestrator validates shape before the handler runs. The handler
          // additionally cross-checks proposalIds and observationId.
          input: '${state.result}',
        },
        // Loop back to review on validation failure. The handler emits a
        // step error whose message becomes feedback for the next iteration.
        onSuccess: { next: [] },
        onFailure: { next: [{ stepId: 'review' }] },
      },
    ],
    startStepId: 'review',
    supportedModes: ['api'],
  };
}

// ============================================================================
// Exports
// ============================================================================

export const CYBERNETIC_AGENTS: CapabilityFlowDefinition[] = [
  buildCyberneticHelmsman(),
  buildCyberneticRunner(),
  buildCyberneticCoach(),
];

export const CYBERNETIC_SYSTEM_ROLES: Record<string, string> = {
  'cybernetic-helmsman': 'cybernetic-helmsman',
  'cybernetic-runner': 'cybernetic-runner',
  'cybernetic-coach': 'cybernetic-coach',
};

export const CYBERNETIC_AGENT_VERSION = '1';
