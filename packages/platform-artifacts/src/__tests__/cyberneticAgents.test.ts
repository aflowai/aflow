import { describe, it, expect } from 'vitest';
import { AgentDefinitionSchema } from '@aflow/schemas';
import { CYBERNETIC_AGENTS } from '../cyberneticAgents.js';

describe('platform-artifacts cybernetic ensemble — runtime source of truth', () => {
  it('Runner grants NO ambient tools — the base catalog is empty (Plan 233)', () => {
    // The Runner is a per-task worker: its tool surface must be exactly what
    // the task declared (capabilities.operations + grants), never an ambient
    // default set. A non-empty base here would re-introduce the confusion +
    // cost that Plan 233 removed (the dogfood `discover` task reaching for
    // compute it never declared). memory.store.get — the sole universal floor
    // — is added at RUNTIME by withGuaranteedReadOps, not baked into the base.
    // This also subsumes the R2 single-writer invariant (Plan 132v2 §Phase 7):
    // an empty base cannot carry any durable workflow-write op.
    const runner = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-runner');
    expect(runner).toBeDefined();
    const step = runner!.steps[0] as Record<string, unknown>;
    const config = step['config'] as Record<string, unknown>;
    const catalog = config['catalog'] as Record<string, unknown>;
    const ops = catalog['coreOperations'] as unknown[];

    expect(ops).toEqual([]);
  });

  it('Runner declares no total budget ceiling — it would be a one-way door', () => {
    // `applyAgentDecision` compares budgetHints against monotonic per-session
    // counters (`ai.agent.turnNumber.*`, `ai.agent.totalCalls.*`) and nothing
    // resets or extends either on resume, so the first turn past a total
    // ceiling pauses and every later turn pauses again on the same
    // comparison — the task can never finish, however many times the operator
    // replies. A platform-wide runaway guard has to be resumable, which needs
    // an allowance mechanism that does not exist yet. Re-adding a total
    // ceiling here before that exists is the regression this pins.
    const runner = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-runner');
    const step = runner!.steps[0] as Record<string, unknown>;
    const config = step['config'] as Record<string, unknown>;
    const turnPolicy = config['turnPolicy'] as Record<string, unknown>;

    expect(turnPolicy['maxToolCallsPerTurn']).toBeGreaterThan(0);
    expect(turnPolicy['budgetHints']).toBeUndefined();
  });

  it('cybernetic-driver agent is gone from the runtime registry (Plan 132v2 §Phase 6)', () => {
    expect(CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-driver')).toBeUndefined();
  });

  it('Helmsman has no start-workflow graph step — runs start via the native workflow.run.start op', () => {
    const helmsman = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-helmsman');
    expect(helmsman).toBeDefined();
    const steps = helmsman!.steps as Array<Record<string, unknown>>;
    // The redundant wrapper step is gone. workflow.run.start is a native
    // coreOperation whose arg is `slug` (the wrapper's required `workflowSlug`
    // arg — absent when Helmsman called it with only `slug` — was the footgun).
    expect(steps.find((s) => s['stepId'] === 'start-workflow')).toBeUndefined();

    const agentStep = steps.find((s) => s['stepId'] === 'agent');
    const config = agentStep!['config'] as Record<string, unknown>;
    const catalog = config['catalog'] as Record<string, unknown>;
    const ops = catalog['coreOperations'] as unknown[];
    expect(ops).toContain('workflow.run.start');

    // An agent step's onSuccess edges double as its graph-tool surface; the
    // only remaining graph tool is run-coach (learner.review.request — the
    // Helmsman's sole Coach path, which is NOT a coreOperation).
    const onSuccess = agentStep!['onSuccess'] as { next: Array<{ stepId: string }> };
    expect(onSuccess.next.map((e) => e.stepId)).toEqual(['run-coach']);
    const runCoach = steps.find((s) => s['stepId'] === 'run-coach');
    expect(runCoach!['operation']).toBe('learner.review.request');

    // The wrapper's dead state vars retire with it.
    const stateVars = helmsman!.stateVariables as Array<Record<string, unknown>>;
    const varIds = stateVars.map((v) => v['variableId']);
    expect(varIds).not.toContain('workflowSlug');
    expect(varIds).not.toContain('workflowInstructions');
    expect(varIds).not.toContain('workflowInputs');
  });

  it('Helmsman still validates + resolves against AgentDefinitionSchema after the step removal', () => {
    const helmsman = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-helmsman');
    expect(helmsman).toBeDefined();
    // The registry resolves platform agents through AgentDefinitionSchema.parse
    // (loadAgentTargetDefinition). An agent step with a single onSuccess edge
    // (run-coach) and an empty onFailure must still parse cleanly, or the
    // Helmsman becomes unstartable.
    const result = AgentDefinitionSchema.safeParse({
      ...helmsman,
      systemRole: 'cybernetic-helmsman',
      version: '1',
    });
    if (!result.success) {
      throw new Error(
        `cybernetic-helmsman failed AgentDefinitionSchema validation:\n${JSON.stringify(
          result.error.issues,
          null,
          2,
        )}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it('Helmsman coreOperations does NOT add a separate retry op (Plan 149 §2 unified-op)', () => {
    const helmsman = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-helmsman');
    const steps = helmsman!.steps as Array<Record<string, unknown>>;
    const helmsmanTurn = steps.find((s) => s['stepId'] === 'agent');
    const config = helmsmanTurn!['config'] as Record<string, unknown>;
    const catalog = config['catalog'] as Record<string, unknown>;
    const ops = catalog['coreOperations'] as unknown[];
    expect(ops).toContain('workflow.run.resume');
    // No new retry op — retry rides on the existing resume surface.
    expect(ops).not.toContain('workflow.run.retry_task');
    expect(ops).not.toContain('workflow.run.retry_failed_task');
  });

  it('Helmsman coreOperations pins proposal.get, not the list or mutators (Plan 233 Part 3)', () => {
    const helmsman = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-helmsman');
    const steps = helmsman!.steps as Array<Record<string, unknown>>;
    const helmsmanTurn = steps.find((s) => s['stepId'] === 'agent');
    const config = helmsmanTurn!['config'] as Record<string, unknown>;
    const catalog = config['catalog'] as Record<string, unknown>;
    const ops = catalog['coreOperations'] as unknown[];

    // proposal.get (one proposal's detail) is pinned; proposal.list is NOT —
    // the attention block already surfaces pending proposals with summaries, so
    // the list op is discoverable, not every-turn.
    expect(ops).toContain('proposal.get');
    expect(ops).not.toContain('proposal.list');
    // The HITL pointer op stays — this is the resolution path.
    expect(ops).toContain('human.action_center.focus');
    // Mutators are not pinned (they're discoverable — Helmsman promotes them to
    // act on the operator's explicit request).
    expect(ops).not.toContain('proposal.ratify');
    expect(ops).not.toContain('proposal.reject');
    expect(ops).not.toContain('proposal.dismiss');
  });

  it('Helmsman coreOperations includes the two Plan 158 ad-hoc render ops', () => {
    const helmsman = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-helmsman');
    const steps = helmsman!.steps as Array<Record<string, unknown>>;
    const helmsmanTurn = steps.find((s) => s['stepId'] === 'agent');
    const config = helmsmanTurn!['config'] as Record<string, unknown>;
    const catalog = config['catalog'] as Record<string, unknown>;
    const ops = catalog['coreOperations'] as unknown[];

    expect(ops).toContain('ui.artifact.render');
    expect(ops).toContain('ui.surface.visualize');
    // Authoring stays out of Helmsman's core surface.
    expect(ops).not.toContain('ui.artifact.generate');
    expect(ops).not.toContain('ui.artifact.publish');
  });

  it('Helmsman discovery is an op-level preset — occasional ops discoverable, whole domains excluded (Plan 233 Part 3)', () => {
    const helmsman = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-helmsman');
    const steps = helmsman!.steps as Array<Record<string, unknown>>;
    const helmsmanTurn = steps.find((s) => s['stepId'] === 'agent');
    const config = helmsmanTurn!['config'] as Record<string, unknown>;
    const catalog = config['catalog'] as Record<string, unknown>;
    const discovery = catalog['discovery'] as Record<string, unknown>;

    const allowed = discovery['allowedOperationIds'] as string[];
    expect(allowed).toBeDefined();
    // Explicit allow-list, not a step-type scope: no whole-step-type overreach,
    // no future-op auto-inclusion.
    expect(discovery['allowedStepTypes']).toBeUndefined();

    // Occasional / specific-case capabilities are DISCOVERABLE (promotable):
    // integration management, skill inspect/patch, compute, media + UI gen,
    // memory long-tail. (proposal.list is read-only and discoverable; the
    // proposal *resolution* actions are excluded below — operator authority.)
    for (const op of [
      'workflow.manage.patch',
      'workflow.manage.list',
      'api.definition.patch',
      'api.binding.upsert',
      'mcp.server.upsert',
      'compute.sandbox.exec',
      'ui.artifact.generate',
      'ui.applet.instantiate',
      'ui.applet.get',
      'ui.applet.list',
      'ai.media.image',
      'proposal.list',
      'memory.store.delete',
    ]) {
      expect(allowed).toContain(op);
    }

    // Whole domains stay OUT — agent management, coach/learner territory, and
    // operator-authority proposal *resolution* (Helmsman points via
    // human.action_center.focus; the operator decides — Plan 156):
    for (const op of [
      'agent.manage.create',
      'agent.manage.get',
      'catalog.agent.list',
      'guardrail.policy.get',
      'learner.learning.record',
      'proposal.ratify',
      'proposal.reject',
      'proposal.dismiss',
      // raw invoke — calling goes through bound integration tools, not here
      'api.http.call',
      'mcp.tool.call',
      // applet actions reach the agent only as lowered per-action tools
      'ui.applet.act',
    ]) {
      expect(allowed).not.toContain(op);
    }
  });

  it('Helmsman static systemPrompt is the minimal degraded-path fallback with the load-bearing invariant', () => {
    // The live Helmsman prompt is assembled per-session
    // (`assembleHelmsmanPrompt`) and overrides this static def at runtime;
    // the rendering rubric and the rest of the operating prose live there now
    // (see helmsmanPrompt.test.ts). This static def is the fallback used only
    // when assembly fails — it must stay minimal but never lose the invariant
    // that prevents the most expensive mistake: starting a new run to deliver
    // input to a paused one.
    const helmsman = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-helmsman');
    const steps = helmsman!.steps as Array<Record<string, unknown>>;
    const helmsmanTurn = steps.find((s) => s['stepId'] === 'agent');
    const config = helmsmanTurn!['config'] as Record<string, unknown>;
    const prompt = config['systemPrompt'] as string;

    expect(prompt).toContain('workflow.run.start');
    expect(prompt).toContain('suggestedResumeCall');
    expect(prompt.toLowerCase()).toContain('paused run');
    // The fallback stays a stub — the heavy operating prose is not duplicated
    // here (it would drift from the live assembler).
    expect(prompt).not.toContain('## Register mapping');
  });

  it('Coach catalog includes ui.artifact.generate + learner.propose.artifact_update (Plan 158 §6.1)', () => {
    const coach = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-coach');
    expect(coach).toBeDefined();
    const steps = coach!.steps as Array<Record<string, unknown>>;
    const reviewStep = steps.find((s) => s['stepId'] === 'review');
    expect(reviewStep).toBeDefined();
    const config = reviewStep!['config'] as Record<string, unknown>;
    const catalog = config['catalog'] as Record<string, unknown>;
    const ops = catalog['coreOperations'] as unknown[];

    expect(ops).toContain('learner.propose.artifact_update');
    // The propose op needs a draftId — Coach must also have generate
    // in its catalog or it can't author the proposal.
    expect(ops).toContain('ui.artifact.generate');
    // PR #365 review nit — generate's `dataSchema` must match the
    // published version's schema verbatim; Coach fetches it via get
    // before calling generate. Without get, Coach would have to
    // reconstruct the schema from prose and the renderer would warn.
    expect(ops).toContain('ui.artifact.get');
    // ui.artifact.publish stays OUT — only operator ratification (via
    // applyArtifactUpdateOps) publishes Coach-proposed drafts.
    expect(ops).not.toContain('ui.artifact.publish');
  });

  it('Coach prompt teaches the (generate → propose) artifact-refresh path (Plan 158 §6.1)', () => {
    const coach = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-coach');
    const steps = coach!.steps as Array<Record<string, unknown>>;
    const reviewStep = steps.find((s) => s['stepId'] === 'review');
    const config = reviewStep!['config'] as Record<string, unknown>;
    const prompt = config['systemPrompt'] as string;

    // Dedicated section header — operators / future Coach edits
    // should find it by name. Loose match (just "artifact refresh") so
    // a tweak to the §6 reference number doesn't break the test.
    expect(prompt.toLowerCase()).toContain('artifact refresh');

    // Trigger signals — at minimum the runner-reflection (blockers)
    // case, the renderer-warning case, and the catalog-pin-drift case.
    // Loose phrase matches so wording can evolve. `critique` was deleted
    expect(prompt.toLowerCase()).toMatch(/runner.*blockers|blockers.*reflection/);
    expect(prompt.toLowerCase()).not.toContain('critique');
    expect(prompt.toLowerCase()).toMatch(/dataschema|data schema|data-schema|data shape/);
    expect(prompt.toLowerCase()).toContain('catalogpin');

    // Explicit guidance steering Coach AWAY from workflow_change for
    // pure rendering defects (the most common mis-routing mistake).
    expect(prompt).toContain('learner.propose.artifact_update');
    expect(prompt).toContain('learner.propose.workflow_change');
    // The prompt includes the verbatim (generate → propose) chain so
    // the LLM treats it as a literal pattern.
    expect(prompt).toContain('ui.artifact.generate(');
    expect(prompt).toContain('learner.propose.artifact_update(');

    // The worked example carries a real `triggeringRunId` + an
    // evidence shape that mirrors what the propose op requires — keeps
    // Coach honest about citing the source session.
    expect(prompt).toContain('triggeringRunId');
    expect(prompt).toContain('reflectionRefs');

    // PR #365 review nit — prompt explicitly steers Coach at the
    // §4.5.3 render-stub shape for finding the artifactId. The earlier
    // draft pointed at `rendererMetadata.artifactId` which the stub
    // replaces — Coach would have hunted for a field that isn't
    // there. Pin the corrected guidance.
    expect(prompt).toContain('tool_result.artifactId');
    expect(prompt).toContain('NOT `rendererMetadata.artifactId`');

    // PR #365 review nit — prompt directs Coach to fetch the schema
    // via `ui.artifact.get` rather than reconstructing it from prose.
    // Without this, the renderer rejects on the new version.
    expect(prompt).toContain('ui.artifact.get');

    // Anti-patterns called out explicitly — the two "Don't:" lines
    // guard against the two most likely mis-uses.
    expect(prompt.toLowerCase()).toMatch(/don't.*propose an artifact refresh/);
  });
});
