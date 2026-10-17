import { describe, expect, it } from 'vitest';
import type { WorkflowTask } from '@aflow/schemas';
import {
  materializeAndValidateSkillConfig,
  materializeSkillTasks,
} from '../skillValidity/skillValidity.js';
import { computeReadyTasksWithWhen } from '../scheduling/graph.js';

const agent = (taskId: string, extra: Partial<WorkflowTask> = {}): WorkflowTask => ({
  taskId,
  name: taskId,
  goal: `Handle ${taskId}.`,
  ...extra,
});

function triage(routes: WorkflowTask['routes'], questions?: Record<string, unknown>): WorkflowTask {
  return {
    taskId: 'triage',
    name: 'Triage',
    goal: 'Run ai.decision.decide.',
    type: 'operation',
    operation: 'ai.decision.decide',
    inputTemplate: {
      state: 'A ticket',
      questions: questions ?? {
        team: {
          type: 'choice',
          options: { billing: null, technical: null, unclear: null },
          minConfidence: 0.7,
        },
        severity: { type: 'score', levels: ['minor', 'major', 'critical'] },
      },
    },
    ...(routes ? { routes } : {}),
  };
}

const ROUTES: WorkflowTask['routes'] = [
  {
    when: {
      allOf: ["output.answers.team.value == 'billing'", 'output.answers.team.decided == true'],
    },
    enable: ['billing'],
  },
  { when: { expression: "output.answers.team.value == 'unclear'" }, enable: ['escalate'] },
  { when: { expression: 'output.answers.team.decided == false' }, enable: ['escalate'] },
];

const workflow = (routes = ROUTES, extra: WorkflowTask[] = []) => [
  triage(routes),
  agent('billing'),
  agent('escalate'),
  ...extra,
];

function errors(tasks: WorkflowTask[]): string[] {
  return materializeAndValidateSkillConfig({ tasks }).validity.diagnostics.map((d) => d.code);
}

describe('routes are stored on the source and guard their targets when materialized', () => {
  it('derives each target’s guard and its dependency on the source', () => {
    const byId = new Map(materializeSkillTasks(workflow()).map((t) => [t.taskId, t]));
    expect(byId.get('billing')).toMatchObject({
      when: {
        allOf: [
          "tasks.triage.output.answers.team.value == 'billing'",
          'tasks.triage.output.answers.team.decided == true',
        ],
      },
      dependsOn: ['triage'],
    });
    expect(byId.get('escalate')?.when).toEqual({
      anyOf: [
        "tasks.triage.output.answers.team.value == 'unclear'",
        'tasks.triage.output.answers.team.decided == false',
      ],
      onMissingRef: 'skip',
    });
  });

  it('is a valid skill', () => {
    expect(errors(workflow())).toEqual([]);
  });

  it('runs the branch the answer names, and only that branch', () => {
    const tasks = materializeSkillTasks(workflow());
    const decided = (value: string, isDecided: boolean) =>
      computeReadyTasksWithWhen(tasks, new Set(['triage']), new Set(), {
        statuses: new Map([['triage', 'succeeded']]),
        outputs: new Map([
          ['triage', { answers: { team: { type: 'choice', value, decided: isDecided } } }],
        ]),
      });

    const confident = decided('billing', true);
    expect(confident.ready.map((t) => t.taskId)).toEqual(['billing']);
    expect(confident.skipped.map((s) => s.task.taskId)).toEqual(['escalate']);

    const unsure = decided('billing', false);
    expect(unsure.ready.map((t) => t.taskId)).toEqual(['escalate']);
  });
});

describe('routes are checked as a whole', () => {
  it('refuses a route to a task that does not exist', () => {
    expect(
      errors(
        workflow([
          { when: { expression: 'output.answers.team.decided == false' }, enable: ['ghost'] },
        ]),
      ),
    ).toContain('route_target_unknown');
  });

  it('refuses a route to its own task', () => {
    expect(
      errors(
        workflow([
          { when: { expression: 'output.answers.team.decided == false' }, enable: ['triage'] },
        ]),
      ),
    ).toContain('route_target_self');
  });

  it('refuses a task enabled by two sources', () => {
    const other = agent('other', {
      routes: [{ when: { expression: "output.status == 'done'" }, enable: ['billing'] }],
    });
    expect(errors(workflow(ROUTES, [other]))).toContain('route_target_multiple_sources');
  });

  it('refuses a routed task that carries its own when', () => {
    const tasks = workflow().map((t) =>
      t.taskId === 'billing'
        ? {
            ...t,
            when: {
              expression: "tasks.triage.status == 'succeeded'",
              onMissingRef: 'skip' as const,
            },
          }
        : t,
    );
    expect(errors(tasks)).toContain('route_target_has_when');
  });

  it('refuses routes to one task that combine into no single-level guard', () => {
    expect(
      errors(
        workflow([
          ROUTES[0]!,
          { when: { expression: 'output.answers.team.decided == false' }, enable: ['billing'] },
        ]),
      ),
    ).toContain('route_guard_inexpressible');
  });

  it('refuses a condition that is not a comparison on the source’s output', () => {
    expect(
      errors(
        workflow([
          { when: { expression: "tasks.triage.status == 'succeeded'" }, enable: ['billing'] },
        ]),
      ),
    ).toContain('route_unsupported_when');
  });

  it('refuses a route on a path the source never emits', () => {
    expect(
      errors(
        workflow([
          { when: { expression: "output.answers.team.valeu == 'billing'" }, enable: ['billing'] },
        ]),
      ),
    ).toContain('when_output_path_unknown');
  });
});

describe('a decision step’s routes are checked against its questions', () => {
  const route = (expression: string) => [{ when: { expression }, enable: ['billing'] }];

  it('refuses a route on a question the step does not ask', () => {
    expect(errors(workflow(route("output.answers.department.value == 'billing'")))).toContain(
      'route_decision_unknown_question',
    );
  });

  it('refuses a route on an option the question does not offer, naming the options', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: workflow(route("output.answers.team.value == 'sales'")),
    });
    const finding = validity.diagnostics.find((d) => d.code === 'route_decision_unknown_option');
    expect(finding?.detail).toContain('billing, technical, unclear');
  });

  it('refuses a score threshold outside the rubric', () => {
    expect(errors(workflow(route('output.answers.severity.value >= 3')))).toContain(
      'route_decision_threshold_out_of_range',
    );
  });
});
