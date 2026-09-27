import { describe, expect, it } from 'vitest';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
  deriveOpBoundProducerShapes,
  validateAgentOpTaskOnlyTools,
  validateWorkflowGraph,
} from '@aflow/cybernetic-runtime';
import { SkillComposeBundleSchema, type WorkflowTask } from '@aflow/schemas';

const OPEN_PR_SLUG = 'open-pr-from-request';

describe('OPEN_PR_FROM_REQUEST', () => {
  const entry = getSkillCatalogEntry(OPEN_PR_SLUG);
  if (!entry) {
    throw new Error(`skill catalog entry "${OPEN_PR_SLUG}" not found`);
  }
  const wf = entry.bundle.workflow;
  const task = (id: string) => wf.tasks.find((t) => t.taskId === id);

  it('parses as a SkillComposeBundle workflow', () => {
    const parsed = SkillComposeBundleSchema.safeParse(entry.bundle);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues.slice(0, 5), null, 2));
    }
    expect(parsed.success).toBe(true);
  });

  it('passes validateWorkflowGraph after Phase D materialization', () => {
    const tasks = deriveOpBoundProducerShapes(wf.tasks as unknown as WorkflowTask[]);
    const errors = validateWorkflowGraph(tasks, wf.stateVariables);
    expect(errors).toEqual([]);
  });

  it('has the expected 9-task graph', () => {
    expect(new Set(wf.tasks.map((t) => t.taskId))).toEqual(
      new Set([
        'discover',
        'describe',
        'plan-approve',
        'implement',
        'push',
        'open-pr',
        'compose-handoff',
        'write-handoff',
      ]),
    );
  });

  it('implement runs code.agent.run and push runs code.repo.push as operation tasks', () => {
    expect(task('implement')?.type).toBe('operation');
    expect(task('implement')?.operation).toBe('code.agent.run');
    expect(task('push')?.type).toBe('operation');
    expect(task('push')?.operation).toBe('code.repo.push');
  });

  it('no agent task grants an opTaskOnly operation (code.agent.run / code.repo.push)', () => {
    expect(validateAgentOpTaskOnlyTools(wf.tasks)).toBeNull();
    const offenders = wf.tasks
      .filter((t) => t.type === 'agent')
      .filter((t) => {
        const ops = t.context?.capabilities?.operations ?? [];
        return ops.includes('code.agent.run') || ops.includes('code.repo.push');
      })
      .map((t) => t.taskId);
    expect(offenders).toEqual([]);
  });

  it('plan-approve is a human approval gate', () => {
    const approve = task('plan-approve');
    expect(approve?.type).toBe('human');
    expect(approve?.intent).toBe('approve');
    // Platform-fixed approval shape — no custom outputContract.
    expect(approve?.outputContract?.schema).toBeUndefined();
    expect(approve?.approves).toEqual(['discover']);
  });

  // Extract every leaf expression from a task's `when`, regardless of combinator.
  const whenExprs = (id: string): string[] => {
    const w = task(id)?.when as
      { expression: string } | { allOf: string[] } | { anyOf: string[] } | undefined;
    if (!w) return [];
    if ('expression' in w) return [w.expression];
    if ('allOf' in w) return w.allOf;
    if ('anyOf' in w) return w.anyOf;
    return [];
  };

  it('every side-effecting task is gated on the approval (rejecting the plan runs nothing)', () => {
    // Gating does NOT propagate from the approval, so each side-effecting task must
    // carry its own `when` keyed on the approval decision — else a rejected plan
    // still runs the harness, pushes, and opens the PR.
    for (const id of ['implement', 'push', 'open-pr', 'compose-handoff', 'write-handoff']) {
      expect(whenExprs(id), `${id} must be gated on the approval`).toContain(
        "tasks.plan-approve.output.decision == 'approved'",
      );
    }
  });

  it('fix-mode: discover decides the mode; the create-only PR tasks gate on mode==create', () => {
    // discover accepts the fix-mode inputs and decides the mode.
    const dBindings = task('discover')?.inputBindings as Record<string, { kind: string }>;
    expect(dBindings['prNumber']?.kind).toBe('run_input');
    expect(dBindings['branch']?.kind).toBe('run_input');
    const dSchema = task('discover')?.outputContract?.schema as {
      required: string[];
      properties: { mode: { enum: string[] } };
    };
    expect(dSchema.required).toContain('mode');
    expect(dSchema.properties.mode.enum).toEqual(['create', 'fix']);

    // Create-only tasks gate on BOTH approval AND create mode (allOf) — in fix mode
    // they skip and the run just revises the existing PR branch.
    for (const id of ['open-pr', 'compose-handoff', 'write-handoff']) {
      expect(whenExprs(id), id).toContain("tasks.discover.output.mode == 'create'");
    }
    // implement + push run in BOTH modes (approval-gated only).
    for (const id of ['implement', 'push']) {
      expect(whenExprs(id), id).not.toContain("tasks.discover.output.mode == 'create'");
    }

    // prNumber + branch are declared OPTIONAL run inputs (fix mode only).
    const ids = wf.runInputs?.map((r) => r.id) ?? [];
    expect(ids).toEqual(expect.arrayContaining(['request', 'prNumber', 'branch']));
    expect(wf.runInputs?.find((r) => r.id === 'prNumber')?.required).toBe(false);
    expect(wf.runInputs?.find((r) => r.id === 'branch')?.required).toBe(false);
  });

  it('design deliverable: an orthogonal optional axis on discover (no new tasks; the fork is in the brief)', () => {
    const ids = wf.runInputs?.map((r) => r.id) ?? [];
    expect(ids).toContain('deliverable');
    expect(wf.runInputs?.find((r) => r.id === 'deliverable')?.required).toBe(false);
    const dBindings = task('discover')?.inputBindings as Record<string, { kind: string }>;
    expect(dBindings['deliverable']?.kind).toBe('run_input');
    // The design↔code fork lives in discover's brief, not in new tasks/edges.
    expect(task('discover')?.goal).toContain('design');
  });

  it('compose-handoff produces the handoff with no learning authoring', () => {
    const handoff = task('compose-handoff');
    expect(handoff?.type).toBe('agent');
    expect(handoff?.dependsOn).toEqual(['implement']);
    // The output is handoff-only; additionalProperties:false structurally forbids
    // the agent from authoring learnings (review + learning are external — Plan 221).
    const schema = handoff?.outputContract?.schema as {
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(['handoffBody', 'runSummary']);
    // No task records learnings anymore.
    expect(wf.tasks.some((t) => t.operation === 'workflow.learn')).toBe(false);
  });

  it('binds the repo binding from the campaign and the request from a declared run input', () => {
    // The target repo is the campaign config (the engagement target); the
    // bounded request is the per-run input.
    expect(entry.bundle.manifest.campaign?.fields['repo']).toBeDefined();

    // The per-run input is DECLARED on the workflow.
    expect(wf.runInputs?.map((r) => r.id)).toContain('request');
    expect(wf.runInputs?.find((r) => r.id === 'request')?.required).toBe(true);

    // discover (the sole root) reads the request via run_input.
    expect(
      wf.tasks.filter((t) => !t.dependsOn || t.dependsOn.length === 0).map((t) => t.taskId),
    ).toEqual(['discover']);
    const discoverBindings = task('discover')?.inputBindings as Record<string, { kind: string }>;
    expect(discoverBindings['request']?.kind).toBe('run_input');

    // discover ALSO declares request in its inputContract so firstTaskInputContract
    // derives — the bootstrap requires `request` up front (Plan 221 P1).
    const discoverContract = task('discover')?.inputContract?.bindings as Record<
      string,
      { kind: string; path: string }
    >;
    expect(discoverContract?.['request']?.kind).toBe('run_input');
    expect(discoverContract?.['request']?.path).toBe('request');

    // implement binds the repo coordinate from the campaign and branch from discover.
    const implBindings = task('implement')?.inputBindings as Record<
      string,
      { kind: string; path?: string; taskId?: string }
    >;
    expect(implBindings['repo']?.kind).toBe('campaign_input');
    expect(implBindings['repo']?.path).toBe('repo');
    expect(implBindings['branch']?.kind).toBe('task_output');
    expect(implBindings['branch']?.taskId).toBe('discover');

    // push binds the repo binding from the campaign too.
    const pushBindings = task('push')?.inputBindings as Record<string, { kind: string }>;
    expect(pushBindings['repo']?.kind).toBe('campaign_input');

    // Every campaign_input binding references a declared campaign-contract field.
    const contractFields = new Set(Object.keys(entry.bundle.manifest.campaign?.fields ?? {}));
    for (const t of wf.tasks) {
      for (const b of Object.values(t.inputBindings ?? {})) {
        if (b.kind === 'campaign_input') {
          expect(contractFields.has(b.path.split('.')[0]!)).toBe(true);
        }
      }
    }
  });

  it('describe resolves the repo binding coordinates via code.repo.describe (campaign_input)', () => {
    const describe = task('describe');
    expect(describe?.type).toBe('operation');
    expect(describe?.operation).toBe('code.repo.describe');
    const bindings = describe?.inputBindings as Record<string, { kind: string; path?: string }>;
    expect(bindings['repo']?.kind).toBe('campaign_input');
    // open-pr derives owner/repo/defaultBranch from describe's output.
    const openPrBindings = task('open-pr')?.inputBindings as Record<
      string,
      { kind: string; taskId?: string }
    >;
    for (const field of ['owner', 'repo', 'defaultBranch']) {
      expect(openPrBindings[field]?.kind).toBe('task_output');
      expect(openPrBindings[field]?.taskId).toBe('describe');
    }
    // open-pr's PR head/title come from discover.
    expect(openPrBindings['branch']?.taskId).toBe('discover');
    expect(openPrBindings['title']?.taskId).toBe('discover');
  });

  it("implement's contract accepts succeeded OR no_change (an empty diff is not a failure)", () => {
    const schema = task('implement')?.outputContract?.schema as {
      required: string[];
      properties: { status: { enum: string[] } };
    };
    // No longer demands a patch — "nothing to change" (no_change) is a clean
    // outcome; a genuine harness/infra failure is a FAILED step (re_execute bridge).
    expect(schema.required).toEqual(['status']);
    expect(schema.properties.status.enum.sort()).toEqual(['no_change', 'succeeded']);
    expect(task('implement')?.retryability).toBe('safe');
    expect(task('implement')?.maxAttempts).toBe(2);
  });

  it('the patch-consuming tasks gate on implement succeeding (no_change skips them)', () => {
    const succeededLeaf = "tasks.implement.output.status == 'succeeded'";
    const gateExprs = (id: string): string[] => {
      const when = task(id)?.when as { allOf?: string[] } | undefined;
      return when?.allOf ?? [];
    };
    for (const id of ['push', 'open-pr', 'compose-handoff', 'write-handoff']) {
      expect(gateExprs(id), id).toContain(succeededLeaf);
    }
  });

  it('open-pr + write-handoff call GitHub via api.http.call endpoint mode', () => {
    for (const id of ['open-pr', 'write-handoff']) {
      const t = task(id);
      expect(t?.type, id).toBe('operation');
      expect(t?.operation, id).toBe('api.http.call');
      const template = t?.inputTemplate as { apiId: string; endpointId: string };
      expect(template.apiId, id).toBe('github');
    }
    expect((task('open-pr')?.inputTemplate as { endpointId: string }).endpointId).toBe(
      'createPullRequest',
    );
    expect((task('write-handoff')?.inputTemplate as { endpointId: string }).endpointId).toBe(
      'createIssueComment',
    );
  });

  it('the GitHub-calling tasks pin the connection (no static github grant) — Plan 222 P3', () => {
    for (const id of ['open-pr', 'write-handoff']) {
      // No hard-coded github integration grant — an unpinned github task would
      // scope-resolve an arbitrary account.
      const integrations = task(id)?.context?.capabilities?.integrations ?? [];
      expect(integrations, id).toEqual([]);
      // The binding is pinned to the campaign's connection: a connection_binding
      // inputBinding backs an inputTemplate.bindingId $bind.
      const bindings = task(id)?.inputBindings as Record<string, { kind: string }>;
      const connName = Object.entries(bindings).find(
        ([, b]) => b.kind === 'connection_binding',
      )?.[0];
      expect(connName, id).toBeDefined();
      const template = task(id)?.inputTemplate as { bindingId?: { $bind?: string } };
      expect(template.bindingId?.$bind, id).toBe(connName);
    }
  });

  it('open-pr projects the PR number + url + title and promotes them to the run output', () => {
    const open = task('open-pr');
    const projection = open?.outputProjection as Record<string, unknown>;
    expect(Object.keys(projection).sort()).toEqual(['prNumber', 'prTitle', 'prUrl']);
    // Promoted so the run result surfaces the PR to the caller without a follow-up query.
    const promoted = (open?.promoteOutputs ?? []).map((p) => (p as { toState: string }).toState);
    expect(promoted.sort()).toEqual(['prNumber', 'prTitle', 'prUrl']);
    expect(wf.output?.primary).toBe('prNumber');
  });

  it('declares an objective manifest goal with the pr-opened criterion', () => {
    expect(entry.bundle.manifest.goal).toMatchObject({
      type: 'objective',
      criteria: [{ id: 'pr-opened' }],
    });
    expect(entry.bundle.manifest.mode).toBe('process');
  });

  it('is listed in the skill catalog with the expected slug', () => {
    expect(wf.slug).toBe(OPEN_PR_SLUG);
    expect(wf.slug).toBe(entry.bundle.manifest.skillId);
  });
});
