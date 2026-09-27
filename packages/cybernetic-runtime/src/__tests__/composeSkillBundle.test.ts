import { describe, it, expect } from 'vitest';
import { getPlatformWorkflow } from '@aflow/platform-artifacts';
import { WorkflowTaskSchema } from '@aflow/schemas';

describe('compose-skill workflow — Plan 123 §6.3 Phase C.2 pipeline shape', () => {
  const wf = getPlatformWorkflow('compose-skill');

  it('exists in the platform registry', () => {
    expect(wf).not.toBeNull();
  });

  it('every task parses cleanly against WorkflowTaskSchema', () => {
    for (const task of wf!.tasks) {
      const result = WorkflowTaskSchema.safeParse(task);
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        throw new Error(
          `task "${(task as { taskId: string }).taskId}" failed WorkflowTaskSchema parse: ${issues}`,
        );
      }
    }
  });

  it('has the eight pipeline tasks in dependency order', () => {
    expect(wf!.tasks).toHaveLength(8);
    const ids = (wf!.tasks as Array<{ taskId: string }>).map((t) => t.taskId);
    expect(ids).toEqual([
      'analyze-intent',
      'prepare-design-surface',
      'draft-task-graph',
      // Pre-assemble graph validators (route back to draft-task-graph on
      // contract failure via onContractFailure.perBinding[draft] = 'rerun').
      'validate-task-graph',
      'validate-source-coverage',
      'validate-capability-grants',
      'assemble-workflow',
      'validate-and-propose',
    ]);
  });

  it('design-skill no longer exists', () => {
    const ids = (wf!.tasks as Array<{ taskId: string }>).map((t) => t.taskId);
    expect(ids).not.toContain('design-skill');
  });

  it('Plan 123 cleanup — runtime.typedInputs flag is gone (typed channel is unconditional)', () => {
    const runtime = (wf as unknown as { runtime?: Record<string, unknown> }).runtime;
    expect(runtime).toBeUndefined();
  });

  it('draft-task-graph declares the draft-only validatorRefs for in-session submit checks (Plan 206)', () => {
    const t = (wf!.tasks as Array<Record<string, unknown>>).find(
      (x) => x['taskId'] === 'draft-task-graph',
    )!;
    const oc = t['outputContract'] as { validatorRefs?: string[] } | undefined;
    // Plan 206 runs the full Zod (compose.task-graph-draft) + cross-task
    // graph consistency at submit_output so the Runner self-corrects in
    // session. capability-references-bound stays a downstream op
    // (validate-capability-grants) — it is space-dependent, not draft-only.
    expect(oc?.validatorRefs ?? []).toContain('compose.task-graph-draft');
    expect(oc?.validatorRefs ?? []).toContain('task-graph-self-consistent');
    expect(oc?.validatorRefs ?? []).not.toContain('capability-references-bound');
  });

  it('draft-task-graph declares typed agent inputBindings (intent, surface, system_feedback)', () => {
    const t = (wf!.tasks as Array<Record<string, unknown>>).find(
      (x) => x['taskId'] === 'draft-task-graph',
    )!;
    const ib = t['inputBindings'] as Record<
      string,
      { kind?: string; taskId?: string; path?: string }
    >;
    expect(ib['intent']?.kind).toBe('task_output');
    expect(ib['intent']?.taskId).toBe('analyze-intent');
    expect(ib['surface']?.kind).toBe('task_output');
    expect(ib['surface']?.taskId).toBe('prepare-design-surface');
    expect(ib['surface']?.path).toBe('designSurface');
    // system_feedback is auto-injected on rerun (Phase B-prime). Its
    // declaration here makes the input typed and present-or-absent.
    expect(ib['system_feedback']?.kind).toBe('system_feedback');
  });

  it('each pre-assemble validator routes draft failures back to draft-task-graph (rerun)', () => {
    const validators = [
      'validate-task-graph',
      'validate-source-coverage',
      'validate-capability-grants',
    ];
    for (const taskId of validators) {
      const t = (wf!.tasks as Array<Record<string, unknown>>).find((x) => x['taskId'] === taskId);
      expect(t, `${taskId} present`).toBeDefined();
      const ocf = t!['onContractFailure'] as
        { perBinding?: Record<string, { producer?: string }> } | undefined;
      expect(ocf?.perBinding?.['draft']?.producer).toBe('rerun');
    }
  });

  it("validate-source-coverage routes intent failures to signal_blocked (intent isn't re-derivable)", () => {
    const t = (wf!.tasks as Array<Record<string, unknown>>).find(
      (x) => x['taskId'] === 'validate-source-coverage',
    )!;
    const ocf = t['onContractFailure'] as
      { perBinding?: Record<string, { producer?: string }> } | undefined;
    expect(ocf?.perBinding?.['intent']?.producer).toBe('signal_blocked');
  });

  it('validate-capability-grants routes surface failures to fail (surface is deterministic)', () => {
    const t = (wf!.tasks as Array<Record<string, unknown>>).find(
      (x) => x['taskId'] === 'validate-capability-grants',
    )!;
    const ocf = t['onContractFailure'] as
      { perBinding?: Record<string, { producer?: string }> } | undefined;
    expect(ocf?.perBinding?.['surface']?.producer).toBe('fail');
  });

  it('assemble-workflow gates on ALL three pre-assemble validators (dependsOn)', () => {
    const t = (wf!.tasks as Array<Record<string, unknown>>).find(
      (x) => x['taskId'] === 'assemble-workflow',
    )!;
    expect(t['dependsOn']).toEqual([
      'validate-task-graph',
      'validate-source-coverage',
      'validate-capability-grants',
    ]);
  });

  it('assemble-workflow inputBindings still point at the original producers (validators are gates, not data sources)', () => {
    const t = (wf!.tasks as Array<Record<string, unknown>>).find(
      (x) => x['taskId'] === 'assemble-workflow',
    )!;
    expect(t['type']).toBe('operation');
    expect(t['operation']).toBe('skill.compose.assemble_workflow');
    const ib = t['inputBindings'] as Record<
      string,
      { kind?: string; taskId?: string; path?: string }
    >;
    expect(ib['intent']?.taskId).toBe('analyze-intent');
    expect(ib['surface']?.taskId).toBe('prepare-design-surface');
    expect(ib['draft']?.taskId).toBe('draft-task-graph');
  });

  it('no eval-authoring nodes exist', () => {
    const ids = (wf!.tasks as Array<{ taskId: string }>).map((t) => t.taskId);
    expect(ids).not.toContain('draft-evals');
    expect(ids).not.toContain('validate-evals-against-workflow');
  });

  it('validate-and-propose depends on assemble-workflow and binds no evals', () => {
    const t = (wf!.tasks as Array<Record<string, unknown>>).find(
      (x) => x['taskId'] === 'validate-and-propose',
    )!;
    expect(t['operation']).toBe('skill.compose.propose');
    expect(t['dependsOn']).toEqual(['assemble-workflow']);
    const ib = t['inputBindings'] as Record<string, unknown>;
    expect(ib['evals']).toBeUndefined();
    expect(ib['assembled']).toBeDefined();
  });
});
