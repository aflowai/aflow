import { describe, expect, it } from 'vitest';
import type { Workflow, WorkflowTask } from '@aflow/schemas';
import {
  buildSkillGraph,
  conditionEdgeLabel,
  whenClausesBySource,
  type TaskNodeData,
} from './skill-graph.js';

function makeWorkflow(tasks: Array<Partial<WorkflowTask>>): Workflow {
  return {
    name: 'Test skill',
    goal: 'test',
    mode: 'process',
    tasks: tasks.map((t) => ({ name: t.taskId, goal: 'do', ...t })),
    outcomes: [],
  } as unknown as Workflow;
}

const WORKFLOW = makeWorkflow([
  { taskId: 'plan-approve', type: 'human', intent: 'approve' },
  {
    taskId: 'implement',
    agent: 'runner',
    dependsOn: ['plan-approve'],
    when: {
      expression: "tasks.plan-approve.output.decision == 'approved'",
      onMissingRef: 'skip',
    },
  },
  {
    taskId: 'push',
    operation: 'code.repo.push',
    dependsOn: ['implement'],
    when: {
      allOf: [
        "tasks.plan-approve.output.decision == 'approved'",
        "tasks.implement.output.status == 'succeeded'",
      ],
      onMissingRef: 'skip',
    },
  },
]);

describe('whenClausesBySource', () => {
  it('groups clauses by the referenced upstream task, prefix stripped', () => {
    const push = WORKFLOW.tasks.find((t) => t.taskId === 'push')!;
    const bySource = whenClausesBySource(push);
    expect(bySource.get('plan-approve')).toEqual(["output.decision == 'approved'"]);
    expect(bySource.get('implement')).toEqual(["output.status == 'succeeded'"]);
  });

  it('returns empty for unguarded tasks and unparseable clauses', () => {
    const approve = WORKFLOW.tasks.find((t) => t.taskId === 'plan-approve')!;
    expect(whenClausesBySource(approve).size).toBe(0);
    expect(
      whenClausesBySource({
        taskId: 't',
        when: { expression: 'not-a-task-reference', onMissingRef: 'skip' },
      } as WorkflowTask).size,
    ).toBe(0);
  });
});

describe('conditionEdgeLabel', () => {
  it('joins with & for allOf/single and | for anyOf', () => {
    const allTask = { when: { allOf: ['a', 'b'], onMissingRef: 'skip' } } as WorkflowTask;
    const anyTask = { when: { anyOf: ['a', 'b'], onMissingRef: 'skip' } } as WorkflowTask;
    expect(conditionEdgeLabel(allTask, ['x == 1', 'y == 2'])).toBe('x == 1 & y == 2');
    expect(conditionEdgeLabel(anyTask, ['x == 1', 'y == 2'])).toBe('x == 1 | y == 2');
  });

  it('truncates long labels', () => {
    const task = { when: { expression: 'a', onMissingRef: 'skip' } } as WorkflowTask;
    const label = conditionEdgeLabel(task, ['x'.repeat(200)]);
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('buildSkillGraph conditional rendering', () => {
  const graph = buildSkillGraph(WORKFLOW);

  it('labels a dependsOn edge whose target guard references the source', () => {
    const edge = graph.edges.find((e) => e.id === 'plan-approve->implement');
    expect(edge?.label).toBe("output.decision == 'approved'");
    expect(edge?.style?.strokeDasharray).toBe('5 4');
  });

  it('labels only the clause(s) referencing that source; other clauses stay card-only', () => {
    const edge = graph.edges.find((e) => e.id === 'implement->push');
    expect(edge?.label).toBe("output.status == 'succeeded'");
  });

  it('keeps unguarded edges as plain control edges', () => {
    const unguarded = buildSkillGraph(
      makeWorkflow([
        { taskId: 'a', agent: 'r' },
        { taskId: 'b', agent: 'r', dependsOn: ['a'] },
      ]),
    );
    const edge = unguarded.edges.find((e) => e.id === 'a->b');
    expect(edge?.label).toBeUndefined();
    expect(edge?.style?.strokeDasharray).toBeUndefined();
  });

  it('carries the display view on guarded task nodes', () => {
    const node = graph.nodes.find((n) => n.id === 'implement');
    const data = node?.data as TaskNodeData;
    expect(data.when).toEqual({
      mode: 'single',
      clauses: ["plan-approve.output.decision == 'approved'"],
      onMissingRef: 'skip',
    });
    const approveData = graph.nodes.find((n) => n.id === 'plan-approve')?.data as TaskNodeData;
    expect(approveData.when).toBeUndefined();
  });

  it('does not badge a producer that gates only one edge', () => {
    const producer = graph.nodes.find((n) => n.id === 'plan-approve')?.data as TaskNodeData;
    expect(producer.branchSubjects).toBeUndefined();
  });
});

describe('branch fans — decision reads at the producer', () => {
  const fanGraph = buildSkillGraph(
    makeWorkflow([
      { taskId: 'plan-approve', type: 'human', intent: 'approve' },
      {
        taskId: 'implement',
        agent: 'runner',
        dependsOn: ['plan-approve'],
        when: {
          expression: "tasks.plan-approve.output.decision == 'approved'",
          onMissingRef: 'skip',
        },
      },
      {
        taskId: 'notify-author',
        operation: 'api.http.call',
        dependsOn: ['plan-approve'],
        when: {
          expression: "tasks.plan-approve.output.decision == 'rejected'",
          onMissingRef: 'skip',
        },
      },
    ]),
  );

  it('compacts fan edge labels to the outcome comparison', () => {
    expect(fanGraph.edges.find((e) => e.id === 'plan-approve->implement')?.label).toBe(
      "== 'approved'",
    );
    expect(fanGraph.edges.find((e) => e.id === 'plan-approve->notify-author')?.label).toBe(
      "== 'rejected'",
    );
  });

  it('badges the producer with the branch subject (output. prefix stripped)', () => {
    const producer = fanGraph.nodes.find((n) => n.id === 'plan-approve')?.data as TaskNodeData;
    expect(producer.branchSubjects).toEqual(['decision']);
  });
});

describe('routes — one source, labelled edges to each task it enables', () => {
  const routed = makeWorkflow([
    {
      taskId: 'triage',
      operation: 'ai.decision.decide',
      routes: [
        { when: { expression: "output.answers.team.value == 'billing'" }, enable: ['billing'] },
        { when: { expression: "output.answers.team.value == 'technical'" }, enable: ['technical'] },
      ],
    },
    { taskId: 'billing', agent: 'r' },
    { taskId: 'technical', agent: 'r' },
  ]);
  const graph = buildSkillGraph(routed);

  it('draws each route as a conditional edge from the source', () => {
    const billing = graph.edges.find((e) => e.id === 'triage->billing');
    expect(billing?.data).toEqual({ conditional: true });
    expect(billing?.label).toContain("'billing'");
    expect(graph.edges.find((e) => e.id === 'triage->technical')?.label).toContain("'technical'");
  });

  it('does not treat a routed task as an entry', () => {
    expect(graph.edges.some((e) => e.target === 'billing' && e.source !== 'triage')).toBe(false);
  });

  it('keeps the stored task on the node, with no guard written into it', () => {
    const data = graph.nodes.find((n) => n.id === 'billing')?.data as TaskNodeData;
    expect(data.task.when).toBeUndefined();
    expect(data.when?.clauses).toEqual(["triage.output.answers.team.value == 'billing'"]);
  });
});
