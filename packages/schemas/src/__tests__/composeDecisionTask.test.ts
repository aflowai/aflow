import { describe, expect, it } from 'vitest';
import { TaskGraphDraftSchema } from '../cybernetic/composeSkill.js';
import { toJsonSchemaSync } from '../utils/jsonSchema.js';

const header = {
  slug: 'ticket-triage',
  name: 'Ticket Triage',
  description: 'Route support tickets.',
  goal: 'Route each ticket to the team that owns it.',
  outcomes: [
    {
      id: 'routed',
      name: 'Routed',
      evaluator: { type: 'manual' as const, instruction: 'Routed.' },
    },
  ],
};

const agent = (taskId: string, extra: Record<string, unknown> = {}) => ({
  type: 'agent',
  kind: 'transformer',
  taskId,
  goal: `Handle ${taskId}.`,
  ...extra,
});

const read = agent('read', {
  produces: [{ key: 'ticket', shape: { type: 'string' }, semantics: 'data' }],
});

const triage = (overrides: Record<string, unknown> = {}) => ({
  type: 'decision',
  taskId: 'triage',
  consumes: [{ taskId: 'read', outputKey: 'ticket', bindAs: 'ticket' }],
  questions: {
    team: {
      type: 'choice',
      instructions: 'Which team owns this ticket',
      options: { billing: 'Payments and refunds', technical: 'Bugs and outages' },
      minConfidence: 0.7,
    },
    urgent: { type: 'yes_no', instructions: 'The ticket is time-sensitive' },
  },
  routes: [
    { question: 'team', equals: 'billing', to: ['billing'] },
    { question: 'team', equals: 'technical', to: ['technical'] },
    { question: 'urgent', equals: true, to: ['page'] },
  ],
  onUndecided: ['escalate'],
  ...overrides,
});

function draft(tasks: unknown[]) {
  return TaskGraphDraftSchema.safeParse({ ...header, tasks });
}

const downstream = [agent('billing'), agent('technical'), agent('page'), agent('escalate')];

function messages(tasks: unknown[]): string[] {
  const result = draft(tasks);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

describe('a decision task in a compose draft', () => {
  it('expands into the operation it runs and the guards its routes imply', () => {
    const result = draft([read, triage(), ...downstream]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const byId = new Map(result.data.tasks.map((t) => [t.taskId, t]));

    expect(byId.get('triage')).toMatchObject({
      type: 'operation',
      operationId: 'ai.decision.decide',
      inputTemplate: {
        state: { ticket: { $bind: 'ticket' } },
        questions: { team: { type: 'choice' }, urgent: { type: 'yes_no' } },
      },
      consumes: [{ taskId: 'read', outputKey: 'ticket', bindAs: 'ticket' }],
    });
    expect(byId.get('billing')).toMatchObject({
      when: {
        allOf: [
          "tasks.triage.output.answers.team.value == 'billing'",
          'tasks.triage.output.answers.team.decided == true',
        ],
      },
      dependsOn: ['triage'],
    });
    // A question with no minConfidence is always decided, so its route is one comparison.
    expect(byId.get('page')).toMatchObject({
      when: 'tasks.triage.output.answers.urgent.value == true',
    });
    expect(byId.get('escalate')).toMatchObject({
      when: 'tasks.triage.output.answers.team.decided == false',
      dependsOn: ['triage'],
    });
    expect(result.data.tasks.some((t) => (t as { type: string }).type === 'decision')).toBe(false);
  });

  it('routes a score by threshold', () => {
    const result = draft([
      read,
      triage({
        questions: { severity: { type: 'score', levels: ['minor', 'major', 'critical'] } },
        routes: [{ question: 'severity', atLeast: 1.5, to: ['page'] }],
        onUndecided: [],
      }),
      agent('page'),
    ]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.tasks.find((t) => t.taskId === 'page')).toMatchObject({
      when: 'tasks.triage.output.answers.severity.value >= 1.5',
    });
  });

  it('refuses a route to an option the question does not offer, naming the options', () => {
    const found = messages([
      read,
      triage({ routes: [{ question: 'team', equals: 'sales', to: ['billing'] }] }),
      ...downstream,
    ]);
    expect(found.join('\n')).toContain(
      'offers no option "sales". Its options are: billing, technical',
    );
  });

  it('refuses a route to a task that does not exist', () => {
    expect(
      messages([read, triage(), agent('billing'), agent('technical'), agent('escalate')]).join(),
    ).toContain('"page" is not a task in this draft');
  });

  it('refuses a task enabled by two routes', () => {
    const found = messages([
      read,
      triage({
        routes: [
          { question: 'team', equals: 'billing', to: ['billing'] },
          { question: 'urgent', equals: true, to: ['billing'] },
        ],
      }),
      ...downstream,
    ]);
    expect(found.join()).toContain('"billing" is already enabled by');
  });

  it('refuses a routed task that carries its own when', () => {
    const found = messages([
      read,
      triage(),
      agent('billing', { when: "tasks.read.status == 'succeeded'" }),
      agent('technical'),
      agent('page'),
      agent('escalate'),
    ]);
    expect(found.join()).toContain('"billing" has a when of its own');
  });

  it('requires onUndecided when a routed question sets minConfidence', () => {
    expect(messages([read, triage({ onUndecided: [] }), ...downstream]).join()).toContain(
      'Name the task that handles them in onUndecided',
    );
  });

  it('refuses onUndecided that could never run', () => {
    const found = messages([
      read,
      triage({
        questions: { urgent: { type: 'yes_no' } },
        routes: [{ question: 'urgent', equals: true, to: ['page'] }],
      }),
      agent('page'),
      agent('escalate'),
    ]);
    expect(found.join()).toContain('onUndecided would never run');
  });

  it('refuses a score threshold outside the rubric', () => {
    const found = messages([
      read,
      triage({
        questions: { severity: { type: 'score', levels: ['minor', 'major'] } },
        routes: [{ question: 'severity', atLeast: 3, to: ['page'] }],
        onUndecided: [],
      }),
      agent('page'),
    ]);
    expect(found.join()).toContain('scores from 0 to 1');
  });

  it('refuses a decision with nothing to read', () => {
    expect(messages([triage({ consumes: [] }), ...downstream]).join()).toContain(
      'consume at least one upstream output',
    );
  });

  it('is offered to the author in the draft’s JSON Schema', () => {
    expect(JSON.stringify(toJsonSchemaSync(TaskGraphDraftSchema))).toContain('"decision"');
  });
});
