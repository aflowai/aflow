import { describe, expect, it } from 'vitest';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
  deriveOpBoundProducerShapes,
  validateAgentOpTaskOnlyTools,
  validateWorkflowGraph,
} from '@aflow/cybernetic-runtime';
import { SkillComposeBundleSchema, type WorkflowTask } from '@aflow/schemas';

const PR_SHEPHERD_SLUG = 'pr-shepherd';

describe('PR_SHEPHERD', () => {
  const entry = getSkillCatalogEntry(PR_SHEPHERD_SLUG);
  if (!entry) {
    throw new Error(`skill catalog entry "${PR_SHEPHERD_SLUG}" not found`);
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

  it('has the expected task graph', () => {
    expect(new Set(wf.tasks.map((t) => t.taskId))).toEqual(
      new Set([
        'describe',
        'rehydrate',
        'implement-fix',
        'push',
        'merge-approve',
        'merge',
        'abandon',
        'compose-handoff',
        'update-handoff',
      ]),
    );
  });

  it('implement-fix runs code.agent.run and push runs code.repo.push as operation tasks', () => {
    expect(task('implement-fix')?.type).toBe('operation');
    expect(task('implement-fix')?.operation).toBe('code.agent.run');
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

  it('merge-approve is a human approval gate over rehydrate', () => {
    const approve = task('merge-approve');
    expect(approve?.type).toBe('human');
    expect(approve?.intent).toBe('approve');
    // Platform-fixed approval shape — no custom outputContract.
    expect(approve?.outputContract?.schema).toBeUndefined();
    expect(approve?.approves).toEqual(['rehydrate']);
  });

  it('every side-effecting task carries its own when gate (gating does not propagate)', () => {
    // The fix path gates on the fix decision; merge gates on the approval decision; abandon
    // gates on the abandon decision — each independently, or a non-matching decision still acts.
    const gateExprs = (id: string): string[] => {
      const when = task(id)?.when as { expression?: string; allOf?: string[] } | undefined;
      if (when?.allOf) return when.allOf;
      return when?.expression ? [when.expression] : [];
    };
    for (const id of ['implement-fix', 'push']) {
      expect(gateExprs(id), `${id} must gate on action == 'fix'`).toContain(
        "tasks.rehydrate.output.action == 'fix'",
      );
    }
    // push additionally gates on the fix producing a patch — no_change skips it.
    expect(gateExprs('push')).toContain("tasks.implement-fix.output.status == 'succeeded'");
    expect(task('merge')?.when?.expression).toContain(
      "tasks.merge-approve.output.decision == 'approved'",
    );
    expect(task('abandon')?.when?.expression).toContain(
      "tasks.rehydrate.output.action == 'abandon'",
    );
    // The continuity writes are intentionally ALWAYS-ON (ungated): every pass keeps
    // the PR handoff current regardless of the branch taken.
    expect(task('compose-handoff')?.when).toBeUndefined();
    expect(task('update-handoff')?.when).toBeUndefined();
  });

  it('compose-handoff produces the handoff with no learning authoring', () => {
    const handoff = task('compose-handoff');
    expect(handoff?.type).toBe('agent');
    expect(handoff?.dependsOn).toEqual(['rehydrate']);
    const schema = handoff?.outputContract?.schema as {
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(['handoffBody', 'runSummary']);
    // No task records learnings anymore (review + learning are external — Plan 221).
    expect(wf.tasks.some((t) => t.operation === 'workflow.learn')).toBe(false);
  });

  it('binds the repo binding from the campaign and the PR number from a declared run input', () => {
    // The target repo is the campaign config (the engagement target); the PR
    // number is the per-run input.
    expect(entry.bundle.manifest.campaign?.fields['repo']).toBeDefined();

    // The per-run input is DECLARED on the workflow.
    expect(wf.runInputs?.map((r) => r.id)).toContain('prNumber');
    expect(wf.runInputs?.find((r) => r.id === 'prNumber')?.required).toBe(true);

    // describe (the sole root) reads the repo binding from the campaign.
    expect(
      wf.tasks.filter((t) => !t.dependsOn || t.dependsOn.length === 0).map((t) => t.taskId),
    ).toEqual(['describe']);
    const describeBindings = task('describe')?.inputBindings as Record<string, { kind: string }>;
    expect(describeBindings['repo']?.kind).toBe('campaign_input');

    // rehydrate reads the PR number via run_input and owner/repo from describe.
    const rehydrateBindings = task('rehydrate')?.inputBindings as Record<
      string,
      { kind: string; taskId?: string }
    >;
    expect(rehydrateBindings['prNumber']?.kind).toBe('run_input');
    expect(rehydrateBindings['owner']?.kind).toBe('task_output');
    expect(rehydrateBindings['owner']?.taskId).toBe('describe');

    // implement-fix binds the repo coordinate from the campaign and branch (the existing
    // PR branch) from rehydrate.
    const implBindings = task('implement-fix')?.inputBindings as Record<
      string,
      { kind: string; taskId?: string }
    >;
    expect(implBindings['repo']?.kind).toBe('campaign_input');
    expect(implBindings['branch']?.kind).toBe('task_output');
    expect(implBindings['branch']?.taskId).toBe('rehydrate');

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
    // merge/abandon/update-handoff derive owner/repo from describe.
    for (const id of ['merge', 'abandon', 'update-handoff']) {
      const bindings = task(id)?.inputBindings as Record<string, { kind: string; taskId?: string }>;
      expect(bindings['owner']?.kind, id).toBe('task_output');
      expect(bindings['owner']?.taskId, id).toBe('describe');
      expect(bindings['repo']?.taskId, id).toBe('describe');
    }
  });

  it("implement-fix's contract accepts succeeded OR no_change (an empty diff is not a failure)", () => {
    const schema = task('implement-fix')?.outputContract?.schema as {
      required: string[];
      properties: { status: { enum: string[] } };
    };
    expect(schema.required).toEqual(['status']);
    expect(schema.properties.status.enum.sort()).toEqual(['no_change', 'succeeded']);
    // `safe`: the patch carries no push authority, so a failed run is re_execute-able.
    expect(task('implement-fix')?.retryability).toBe('safe');
    expect(task('implement-fix')?.maxAttempts).toBe(2);
  });

  it('rehydrate grants only the github READ connector tool names, connection-resolved (no fixed account)', () => {
    const integrations = task('rehydrate')?.context?.capabilities?.integrations ?? [];
    const github = integrations.find((i) => i.integrationId === 'github');
    // The agent reads GitHub via granted virtual tools whose binding is deferred to
    // the run's pinned connection — a typed `{kind:'connection'}` ref, NOT a fixed
    // account binding. The capabilityId stays the satisfiable integration id.
    expect(github?.binding).toEqual({ kind: 'connection' });
    expect(github?.capabilityId).toBe('github');
    expect(github?.toolNames?.map((t) => t.toolName).sort()).toEqual([
      'getPullRequest',
      'listCheckRuns',
      'listIssueComments',
      'listPullRequestReviews',
      'listReviewComments',
    ]);
    expect(github?.allTools).toBe(false);
  });

  it('merge + abandon + update-handoff call GitHub via api.http.call endpoint mode', () => {
    for (const id of ['merge', 'abandon', 'update-handoff']) {
      const t = task(id);
      expect(t?.type, id).toBe('operation');
      expect(t?.operation, id).toBe('api.http.call');
      const template = t?.inputTemplate as { apiId: string; endpointId: string };
      expect(template.apiId, id).toBe('github');
    }
    expect((task('merge')?.inputTemplate as { endpointId: string }).endpointId).toBe(
      'mergePullRequest',
    );
    expect((task('abandon')?.inputTemplate as { endpointId: string }).endpointId).toBe(
      'closePullRequest',
    );
    expect((task('update-handoff')?.inputTemplate as { endpointId: string }).endpointId).toBe(
      'createIssueComment',
    );
  });

  it('the GitHub write tasks pin the connection (no static github grant) — Plan 222 P3', () => {
    for (const id of ['merge', 'abandon', 'update-handoff']) {
      // No hard-coded github grant — an unpinned github task would scope-resolve
      // an arbitrary account.
      const integrations = task(id)?.context?.capabilities?.integrations ?? [];
      expect(integrations, id).toEqual([]);
      // The binding is pinned to the campaign's connection.
      const bindings = task(id)?.inputBindings as Record<string, { kind: string }>;
      const connName = Object.entries(bindings).find(
        ([, b]) => b.kind === 'connection_binding',
      )?.[0];
      expect(connName, id).toBeDefined();
      const template = task(id)?.inputTemplate as { bindingId?: { $bind?: string } };
      expect(template.bindingId?.$bind, id).toBe(connName);
    }
  });

  it('declares an objective manifest goal with the pr-tended criterion', () => {
    expect(entry.bundle.manifest.goal).toMatchObject({
      type: 'objective',
      criteria: [{ id: 'pr-tended' }],
    });
    expect(entry.bundle.manifest.mode).toBe('process');
  });

  it('is listed in the skill catalog with the expected slug', () => {
    expect(wf.slug).toBe(PR_SHEPHERD_SLUG);
    expect(wf.slug).toBe(entry.bundle.manifest.skillId);
  });
});
