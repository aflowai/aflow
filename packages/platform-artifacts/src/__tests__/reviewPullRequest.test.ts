import { describe, expect, it } from 'vitest';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
  deriveOpBoundProducerShapes,
  validateAgentOpTaskOnlyTools,
  validateWorkflowGraph,
} from '@aflow/cybernetic-runtime';
import { SkillComposeBundleSchema, type WorkflowTask } from '@aflow/schemas';

const REVIEW_PR_SLUG = 'review-pull-request';

describe('REVIEW_PULL_REQUEST', () => {
  const entry = getSkillCatalogEntry(REVIEW_PR_SLUG);
  if (!entry) {
    throw new Error(`skill catalog entry "${REVIEW_PR_SLUG}" not found`);
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

  it('passes validateWorkflowGraph after Phase D materialization (incl. the verdict gates)', () => {
    const tasks = deriveOpBoundProducerShapes(wf.tasks as unknown as WorkflowTask[]);
    const errors = validateWorkflowGraph(tasks, wf.stateVariables);
    expect(errors).toEqual([]);
  });

  it('has the expected deep-review graph (describe → resolve-pr → review → post×2 + comment fallback)', () => {
    expect(new Set(wf.tasks.map((t) => t.taskId))).toEqual(
      new Set([
        'describe',
        'resolve-pr',
        'review',
        'post-approve',
        'post-request-changes',
        'comment-fallback',
      ]),
    );
  });

  it('describe is the sole root, resolving the repo binding from the campaign', () => {
    expect(
      wf.tasks.filter((t) => !t.dependsOn || t.dependsOn.length === 0).map((t) => t.taskId),
    ).toEqual(['describe']);
    expect(task('describe')?.operation).toBe('code.repo.describe');
    const bindings = task('describe')?.inputBindings as Record<string, { kind: string }>;
    expect(bindings['repo']?.kind).toBe('campaign_input');
  });

  it('resolve-pr reads getPullRequest and projects head/base branch + intent', () => {
    const resolve = task('resolve-pr');
    expect(resolve?.operation).toBe('api.http.call');
    expect(resolve?.dependsOn).toEqual(['describe']);
    expect((resolve?.inputTemplate as { endpointId: string }).endpointId).toBe('getPullRequest');
    const proj = resolve?.outputProjection as Record<string, { path: string }>;
    expect(proj['branch']?.path).toBe('data.head.ref');
    expect(proj['base']?.path).toBe('data.base.ref');
    expect(proj['intent']?.path).toBe('data.title');
  });

  it('review runs code.agent.review read-only over the resolved head branch', () => {
    const review = task('review');
    expect(review?.type).toBe('operation');
    expect(review?.operation).toBe('code.agent.review');
    expect(review?.dependsOn).toEqual(['resolve-pr']);
    const bindings = review?.inputBindings as Record<string, { kind: string; taskId?: string }>;
    expect(bindings['repo']?.kind).toBe('campaign_input');
    expect(bindings['branch']).toMatchObject({ kind: 'task_output', taskId: 'resolve-pr' });
    expect(bindings['baseBranch']).toMatchObject({ kind: 'task_output', taskId: 'resolve-pr' });
    // The reviewer needs NO github integration — it clones via the repo binding.
    expect(review?.context?.capabilities?.integrations ?? []).toEqual([]);
    expect(review?.context?.capabilities?.operations).toEqual(['code.agent.review']);
  });

  it('the verdict deterministically gates two literal-event PR reviews via createReview', () => {
    for (const [taskId, verdict, event] of [
      ['post-approve', 'approve', 'APPROVE'],
      ['post-request-changes', 'request_changes', 'REQUEST_CHANGES'],
    ] as const) {
      const post = task(taskId);
      expect(post?.operation).toBe('api.http.call');
      expect(post?.dependsOn).toEqual(['review', 'describe']);
      expect((post?.when as { expression: string }).expression).toBe(
        `tasks.review.output.verdict == '${verdict}'`,
      );
      const tmpl = post?.inputTemplate as {
        endpointId: string;
        params: { body: { event: string } };
      };
      expect(tmpl.endpointId).toBe('createReview');
      expect(tmpl.params.body.event).toBe(event);
      const body = (post?.inputBindings as Record<string, { taskId?: string }>)['reviewBody'];
      expect(body?.taskId).toBe('review');
    }
  });

  it('promotes the verdict AND the review summary so the outcome needs no double-query', () => {
    const promotes = (task('review')?.promoteOutputs ?? []) as Array<{
      path: string;
      toState: string;
    }>;
    expect(promotes.find((p) => p.path === 'verdict')?.toState).toBe('verdict');
    expect(promotes.find((p) => p.path === 'reviewBody')?.toState).toBe('reviewSummary');
    expect(wf.stateVariables?.map((v) => v.variableId)).toContain('reviewSummary');
  });

  it('falls back to a PR comment when the formal review did not land (own-PR 422)', () => {
    const fb = task('comment-fallback');
    expect(fb?.operation).toBe('api.http.call');
    expect((fb?.inputTemplate as { endpointId: string }).endpointId).toBe('createIssueComment');
    // Fires only when whichever formal post ran returned a non-2xx.
    expect((fb?.when as { anyOf: string[] }).anyOf).toEqual([
      'tasks.post-approve.output.statusCode >= 400',
      'tasks.post-request-changes.output.statusCode >= 400',
    ]);
    // The comment body is the review narrative; the loop still reads the verdict from output.
    const body = (fb?.inputBindings as Record<string, { taskId?: string }>)['reviewBody'];
    expect(body?.taskId).toBe('review');
  });

  it('every github api.http.call task pins the connection (no static github grant) — Plan 222 P3', () => {
    for (const id of ['resolve-pr', 'post-approve', 'post-request-changes', 'comment-fallback']) {
      const t = task(id);
      expect((t?.inputTemplate as { apiId?: string }).apiId, id).toBe('github');
      // No hard-coded github grant — an unpinned github task would scope-resolve
      // an arbitrary account.
      expect(t?.context?.capabilities?.integrations ?? [], id).toEqual([]);
      // The binding is pinned to the campaign's connection.
      const bindings = t?.inputBindings as Record<string, { kind: string }>;
      const connName = Object.entries(bindings).find(
        ([, b]) => b.kind === 'connection_binding',
      )?.[0];
      expect(connName, id).toBeDefined();
      const template = t?.inputTemplate as { bindingId?: { $bind?: string } };
      expect(template.bindingId?.$bind, id).toBe(connName);
    }
  });

  it('is a pure critic: deep review op is read-only, no write code op / merge / learn', () => {
    expect(validateAgentOpTaskOnlyTools(wf.tasks)).toBeNull();
    const ops = wf.tasks.map((t) => t.operation).filter(Boolean);
    // The reviewer IS code.agent.review (read-only) — but never the producing/pushing ops.
    expect(ops).toContain('code.agent.review');
    expect(ops).not.toContain('code.agent.run');
    expect(ops).not.toContain('code.repo.push');
    expect(ops).not.toContain('workflow.learn');
    expect(ops).not.toContain('mergePullRequest');
  });

  it('declares a per-repo campaign keyed on the repo binding identity', () => {
    const repoField = entry.bundle.manifest.campaign?.fields['repo'];
    expect(repoField).toBeDefined();
    expect(repoField?.identity).toBe(true);
    expect(entry.bundle.manifest.goal).toMatchObject({
      type: 'objective',
      criteria: [{ id: 'pr-reviewed' }],
    });
    expect(entry.bundle.manifest.mode).toBe('process');
  });

  it('is listed in the skill catalog with the expected slug', () => {
    expect(wf.slug).toBe(REVIEW_PR_SLUG);
    expect(wf.slug).toBe(entry.bundle.manifest.skillId);
  });
});
