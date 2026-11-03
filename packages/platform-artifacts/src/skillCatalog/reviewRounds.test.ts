/**
 * Review Rounds (Plan 341 P2): the loop's review rounds on a folder's patch
 * alone. The graph is driven here as the harness drives it, with every
 * operation's output scripted and every decision the skill's own.
 */
import { describe, expect, it } from 'vitest';
import {
  computeReadyTasksWithWhen,
  decideByRules,
  materializeAndValidateSkillConfig,
  projectTaskOutput,
  resolvePromotedRunMetrics,
} from '@aflow/cybernetic-runtime';
import {
  HostFilePatchInputSchema,
  NEEDS_SETUP_FINDING_KIND,
  substituteTemplateBinds,
  WorkflowRunDecideInputSchema,
  WorkflowRunDetailInputSchema,
  WorkflowRunStartInputSchema,
  type WorkflowTask,
} from '@aflow/schemas';
import { COMMISSION_CHANGE } from './commissionChange.js';
import { PUBLISH_LOCAL_CHANGES } from './publishLocalChanges.js';
import { AFTER_REVIEW_SETTLE_RULES } from './publishLocalChangesAfterReview.js';
import { REVIEW_LOCAL_CHANGES } from './reviewLocalChanges.js';
import {
  FIRST_ROUND_MINOR_REASON,
  LATER_ROUND_REASON,
  MAJOR_ALWAYS_REASON,
  NITS_ONLY_FIRST_REASON,
  NOT_APPROVED_FIRST_REASON,
  REVIEW_ROUNDS,
  REVIEW_ROUNDS_MAX,
  REVIEW_ROUNDS_OTHERWISE,
  REVIEW_ROUNDS_RULES,
} from './reviewRounds.js';
import { SKILL_BUNDLE_CATALOG } from '../skillBundleCatalog.js';

const wf = REVIEW_ROUNDS.bundle.workflow;
const tasks = wf.tasks as unknown as WorkflowTask[];

const BASE = 'a'.repeat(40);
const headOf = (round: number) => String(round).repeat(40);
/** A stored patch, as a commission reports it. */
const patchRefOf = (round: number) =>
  `gs://aflow-payloads/tenants/t_1/runs/r_${String(round)}/steps/s_1/attempt/1/patch.json`;
const COMMISSION_RUN = '11111111-1111-4111-8111-111111111111';
const RUN_INPUTS = {
  bindingId: 'hb_task',
  commission: COMMISSION_RUN,
  brief: 'add() subtracts. Requirements: add(a, b) returns a + b.',
  branch: 'bench/calc-0001',
};

type Severity = 'blocker' | 'major' | 'minor' | 'nit';
interface Finding {
  severity: Severity;
  file: string;
  claim: string;
  evidence: string;
  kind?: string;
}
const finding = (severity: Severity, kind?: string): Finding => ({
  severity,
  file: 'calc.py',
  claim: `a ${severity}`,
  evidence: 'calc.py:2',
  ...(kind === undefined ? {} : { kind }),
});

interface Review {
  verdict: 'approve' | 'request_changes' | 'comment';
  findings: Finding[];
}
interface Scenario {
  /** Each round's review, in order. A round past the list reviews as not started. */
  reviews: Review[];
  /** The commission reported no patch. */
  emptyCommission?: boolean;
}

function decide(state: Record<string, unknown>) {
  return decideByRules({
    state,
    rules: [...REVIEW_ROUNDS_RULES],
    otherwise: REVIEW_ROUNDS_OTHERWISE,
  });
}

function roundOf(taskId: string): number {
  return Number(taskId.split('-').at(-1));
}

/** What each operation returns, as its executor would — and the check that it was asked rightly. */
function rawOutput(task: WorkflowTask, scenario: Scenario, input: Record<string, unknown>) {
  const id = task.taskId;
  if (id === 'read-commission') {
    expect(WorkflowRunDetailInputSchema.parse(input).runId).toBe(COMMISSION_RUN);
    return {
      run: { runId: COMMISSION_RUN, status: 'completed' },
      result: {
        output: {
          ...(scenario.emptyCommission === true ? {} : { patchRef: patchRefOf(1) }),
          baseSha: BASE,
          summary: { title: 'Make add() add', paragraph: 'add() returned a - b.' },
        },
      },
    };
  }
  const round = roundOf(id);
  if (id.startsWith('commit-')) {
    const parsed = HostFilePatchInputSchema.parse(input);
    expect(parsed.patchRef).toBe(patchRefOf(round));
    expect(parsed.commit?.branch).toBe(RUN_INPUTS.branch);
    expect(parsed.commit?.baseSha).toBe(round === 1 ? BASE : headOf(round - 1));
    return {
      state: 'applied',
      filesChanged: 1,
      files: ['calc.py'],
      conflicts: [],
      commit: { branch: RUN_INPUTS.branch, sha: headOf(round), baseSha: BASE },
    };
  }
  if (id.startsWith('review-')) {
    const parsed = WorkflowRunStartInputSchema.parse(input);
    expect(parsed.catalogId).toBe(REVIEW_LOCAL_CHANGES.catalogId);
    expect(parsed.inputs).toMatchObject({ bindingId: 'hb_task', from: BASE, at: headOf(round) });
    const review = scenario.reviews[round - 1];
    if (review === undefined) return { runId: `review-run-${String(round)}`, outcome: 'failed' };
    return {
      runId: `review-run-${String(round)}`,
      outcome: 'completed',
      result: {
        output: {
          verdict: review.verdict,
          reviewSummary: `review ${String(round)}`,
          findings: review.findings,
        },
      },
    };
  }
  if (id.startsWith('decide-')) {
    return { ...decideByRules(WorkflowRunDecideInputSchema.parse(input)) };
  }
  if (id.startsWith('fix-')) {
    const parsed = WorkflowRunStartInputSchema.parse(input);
    expect(parsed.catalogId).toBe(COMMISSION_CHANGE.catalogId);
    const inputs = parsed.inputs as Record<string, unknown>;
    expect(inputs['base']).toBe(RUN_INPUTS.branch);
    expect(inputs['task']).toContain(RUN_INPUTS.brief);
    expect(inputs['task']).toContain(`review ${String(round - 1)}`);
    return {
      runId: `fix-run-${String(round)}`,
      outcome: 'completed',
      result: {
        output: {
          patchRef: patchRefOf(round),
          baseSha: headOf(round - 1),
          summary: {
            title: `Fix round ${String(round)}`,
            paragraph: 'Fixed what the review found.',
          },
        },
      },
    };
  }
  throw new Error(`no output scripted for ${id}`);
}

function boundInputs(task: WorkflowTask, outputs: Map<string, Record<string, unknown>>) {
  const bound: Record<string, unknown> = {};
  for (const [name, binding] of Object.entries(task.inputBindings ?? {})) {
    let value: unknown;
    if (binding.kind === 'run_input') value = (RUN_INPUTS as Record<string, unknown>)[binding.path];
    if (binding.kind === 'task_output') {
      value = outputs.get(binding.taskId);
      for (const key of binding.path?.split('.') ?? []) {
        value =
          value !== null && typeof value === 'object'
            ? (value as Record<string, unknown>)[key]
            : undefined;
      }
    }
    if (value !== undefined) bound[name] = value;
  }
  return bound;
}

/** Drive the graph: ready tasks run, false predicates skip, an optional task that fails satisfies its dependents. */
function run(scenario: Scenario) {
  const completed = new Set<string>();
  const skipped = new Set<string>();
  const failedOptional = new Set<string>();
  const statuses = new Map<string, string>();
  const outputs = new Map<string, Record<string, unknown>>();
  const inputs = new Map<string, Record<string, unknown>>();
  const ran: string[] = [];
  for (let pass = 0; pass <= tasks.length; pass += 1) {
    const {
      ready,
      skipped: skip,
      errors,
    } = computeReadyTasksWithWhen(tasks, completed, skipped, { statuses, outputs }, failedOptional);
    expect(errors).toEqual([]);
    for (const { task } of skip) {
      skipped.add(task.taskId);
      statuses.set(task.taskId, 'skipped');
    }
    for (const task of ready) {
      if (ran.includes(task.taskId)) continue;
      ran.push(task.taskId);
      const input = substituteTemplateBinds(
        task.inputTemplate ?? {},
        boundInputs(task, outputs),
        new Set(Object.keys(task.inputBindings ?? {})),
      );
      inputs.set(task.taskId, input);
      const raw = rawOutput(task, scenario, input);
      const projected = task.outputProjection
        ? projectTaskOutput(task.outputProjection, raw, input)
        : { ok: true as const, value: raw };
      if (!projected.ok) {
        statuses.set(task.taskId, 'failed');
        if (task.optional === true) failedOptional.add(task.taskId);
        continue;
      }
      outputs.set(task.taskId, projected.value as Record<string, unknown>);
      completed.add(task.taskId);
      statuses.set(task.taskId, 'succeeded');
    }
    if (ready.length === 0 && skip.length === 0) break;
  }
  const state = resolvePromotedRunMetrics(
    tasks,
    [...outputs].map(([taskId, output]) => ({
      taskId,
      status: statuses.get(taskId) ?? 'pending',
      output,
    })),
    wf.stateVariables,
  );
  return { ran, inputs, outputs, state };
}

describe('Review Rounds — the contract', () => {
  it('has a valid contract, and every run input reaches a task', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: wf.tasks,
      stateVariables: wf.stateVariables,
      output: wf.output,
      runInputs: wf.runInputs,
      mode: wf.mode,
    });
    expect(validity.diagnostics.map((d) => `${d.code}: ${d.detail}`)).toEqual([]);
    expect(validity.status).toBe('valid');
    const unreachable = validity.advisories.filter((d) => d.code === 'run_input_unreachable');
    expect(unreachable).toEqual([]);
  });

  it('is the commission read, then a commit, a review and a decision per round, with a fix before every round after the first', () => {
    const rounds = Array.from({ length: REVIEW_ROUNDS_MAX }, (_, i) => {
      const n = String(i + 1);
      return [...(i === 0 ? [] : [`fix-${n}`]), `commit-${n}`, `review-${n}`, `decide-${n}`];
    }).flat();
    expect(tasks.map((task) => task.taskId)).toEqual(['read-commission', ...rounds]);
  });

  it('reaches no remote: no commit names a push base, and nothing pushes, calls an API or runs a command', () => {
    const operations = new Set(tasks.map((task) => task.operation));
    expect([...operations].sort()).toEqual([
      'host.file.patch',
      'workflow.run.decide',
      'workflow.run.detail',
      'workflow.run.start',
    ]);
    for (const task of tasks.filter((t) => t.operation === 'host.file.patch')) {
      const commit = (task.inputTemplate as { commit: Record<string, unknown> }).commit;
      expect(Object.keys(commit).sort()).toEqual(['baseSha', 'branch', 'message']);
    }
  });

  it('starts only Review Local Changes and Commission Change, as the publication starts its review', () => {
    const started = tasks
      .filter((task) => task.operation === 'workflow.run.start')
      .map((task) => (task.inputTemplate as { catalogId: string }).catalogId);
    expect(new Set(started)).toEqual(
      new Set([REVIEW_LOCAL_CHANGES.catalogId, COMMISSION_CHANGE.catalogId]),
    );
  });

  it('ships in an unlisted bundle of its own, outside the Coding Loop, beside the skills it starts', () => {
    const bundle = SKILL_BUNDLE_CATALOG.find((b) =>
      b.skillCatalogIds.includes(REVIEW_ROUNDS.catalogId),
    );
    expect(bundle?.bundleId).toBe('local-review-rounds');
    expect(bundle?.unlisted).toBe(true);
    expect(bundle?.prerequisiteBundleIds).toEqual(['local-commission', 'local-code-review']);
    const loop = SKILL_BUNDLE_CATALOG.find((b) => b.bundleId === 'coding-loop');
    expect(loop?.skillCatalogIds).not.toContain(REVIEW_ROUNDS.catalogId);
  });

  it("leaves the publication's own rounds untouched", () => {
    const settle = PUBLISH_LOCAL_CHANGES.bundle.workflow.tasks.find(
      (t) => t.taskId === 'settle-after-review',
    );
    expect((settle?.inputTemplate as { rules: unknown }).rules).toEqual(AFTER_REVIEW_SETTLE_RULES);
    // The publication publishes an approving major after its fix round, where its push gate asks.
    const majorAfterFix = { verdict: 'approve', findings: [finding('major')], round: 2 };
    expect(
      decideByRules({
        state: majorAfterFix,
        rules: [...AFTER_REVIEW_SETTLE_RULES],
        otherwise: { decision: 'publish_as_is', reason: 'x' },
      }).decision,
    ).toBe('publish_as_is');
    expect(decide(majorAfterFix).decision).toBe('fix_before_merge');
  });
});

describe('Review Rounds — the rounds rule', () => {
  const cases: Array<[string, Record<string, unknown>, string, string]> = [
    [
      'round 1, a minor',
      { round: 1, verdict: 'approve', findings: [finding('nit'), finding('minor')] },
      'fix_before_merge',
      FIRST_ROUND_MINOR_REASON,
    ],
    [
      'round 1, nits alone',
      { round: 1, verdict: 'approve', findings: [finding('nit')] },
      'publish_as_is',
      NITS_ONLY_FIRST_REASON,
    ],
    [
      'round 1, nothing',
      { round: 1, verdict: 'approve', findings: [] },
      'publish_as_is',
      NITS_ONLY_FIRST_REASON,
    ],
    [
      'round 1, not approved',
      { round: 1, verdict: 'comment', findings: [] },
      'fix_before_merge',
      NOT_APPROVED_FIRST_REASON,
    ],
    [
      'round 1, a major',
      { round: 1, verdict: 'request_changes', findings: [finding('major')] },
      'fix_before_merge',
      MAJOR_ALWAYS_REASON,
    ],
    [
      'round 2, minors and nits',
      { round: 2, verdict: 'approve', findings: [finding('minor'), finding('nit')] },
      'publish_as_is',
      LATER_ROUND_REASON,
    ],
    [
      'round 2, not approved without a major',
      { round: 2, verdict: 'comment', findings: [finding('minor')] },
      'publish_as_is',
      LATER_ROUND_REASON,
    ],
    [
      'round 2, a major',
      { round: 2, verdict: 'request_changes', findings: [finding('minor'), finding('major')] },
      'fix_before_merge',
      MAJOR_ALWAYS_REASON,
    ],
    [
      'round 3, a blocker at the last index',
      {
        round: 3,
        verdict: 'request_changes',
        findings: [...Array.from({ length: 49 }, () => finding('nit')), finding('blocker')],
      },
      'fix_before_merge',
      MAJOR_ALWAYS_REASON,
    ],
    [
      'round 1, only the needs_setup minor',
      { round: 1, verdict: 'approve', findings: [finding('minor', NEEDS_SETUP_FINDING_KIND)] },
      'publish_as_is',
      NITS_ONLY_FIRST_REASON,
    ],
  ];
  it.each(cases)('%s', (_name, state, decision, reason) => {
    expect(decide(state)).toMatchObject({ decision, reason });
  });
});

describe('Review Rounds — rounds on a patch with no remote', () => {
  it('takes a first review of nits as it stands: one round, the commission’s commit is the head', () => {
    const { ran, state, inputs } = run({
      reviews: [{ verdict: 'approve', findings: [finding('nit')] }],
    });
    expect(ran).toEqual(['read-commission', 'commit-1', 'review-1', 'decide-1']);
    expect(inputs.get('commit-1')?.['commit']).toMatchObject({
      message: 'Make add() add\n\nadd() returned a - b.',
    });
    expect(state).toMatchObject({
      baseSha: BASE,
      branch: RUN_INPUTS.branch,
      headSha: headOf(1),
      verdict: 'approve',
      decision: 'publish_as_is',
    });
    expect(state['rounds']).toHaveLength(1);
  });

  it('fixes a first-round minor once, then takes a second round of minors as it stands', () => {
    const { ran, state } = run({
      reviews: [
        { verdict: 'approve', findings: [finding('minor')] },
        { verdict: 'approve', findings: [finding('minor')] },
      ],
    });
    expect(ran).toEqual([
      'read-commission',
      'commit-1',
      'review-1',
      'decide-1',
      'fix-2',
      'commit-2',
      'review-2',
      'decide-2',
    ]);
    expect(state).toMatchObject({ headSha: headOf(2), decision: 'publish_as_is' });
    const rounds = state['rounds'] as Array<Record<string, unknown>>;
    expect(rounds.map((r) => [r['round'], r['headSha'], r['reviewRunId']])).toEqual([
      [1, headOf(1), 'review-run-1'],
      [2, headOf(2), 'review-run-2'],
    ]);
  });

  it('fixes a major every round, and the limit ends the rounds with the decision recorded', () => {
    const major = { verdict: 'request_changes' as const, findings: [finding('major')] };
    const { ran, state } = run({ reviews: Array.from({ length: REVIEW_ROUNDS_MAX }, () => major) });
    expect(ran.filter((id) => id.startsWith('review-'))).toHaveLength(REVIEW_ROUNDS_MAX);
    expect(ran.filter((id) => id.startsWith('fix-'))).toHaveLength(REVIEW_ROUNDS_MAX - 1);
    expect(state).toMatchObject({
      headSha: headOf(REVIEW_ROUNDS_MAX),
      decision: 'fix_before_merge',
    });
    expect(state['rounds']).toHaveLength(REVIEW_ROUNDS_MAX);
  });

  it('keeps the last reviewed head where a fix round’s review did not finish', () => {
    const { ran, state } = run({ reviews: [{ verdict: 'approve', findings: [finding('minor')] }] });
    expect(ran).toContain('review-2');
    expect(ran).not.toContain('decide-2');
    expect(state).toMatchObject({
      headSha: headOf(1),
      verdict: 'approve',
      decision: 'fix_before_merge',
    });
  });

  it('reviews nothing where the commission reported no patch', () => {
    const { ran, state } = run({ reviews: [], emptyCommission: true });
    expect(ran).toEqual(['read-commission']);
    expect(state['headSha']).toBeUndefined();
  });
});

describe("Review Rounds — the loop's call path", () => {
  it('takes a Commission Change by its run id, reading the outputs that commission promotes', () => {
    const promoted = new Set(
      COMMISSION_CHANGE.bundle.workflow.stateVariables?.map((v) => v.variableId),
    );
    for (const name of ['patchRef', 'baseSha', 'summary']) expect(promoted.has(name)).toBe(true);
    const required = (wf.runInputs ?? []).filter((i) => i.required).map((i) => i.id);
    expect(required).toEqual(['bindingId', 'commission', 'brief', 'branch']);
  });

  it('briefs each fix round within what Commission Change accepts as its task', () => {
    const brief = (wf.runInputs ?? []).find((i) => i.id === 'brief');
    const task = COMMISSION_CHANGE.bundle.workflow.runInputs?.find((i) => i.id === 'task');
    expect(brief?.schema).toEqual(task?.schema);
  });
});
