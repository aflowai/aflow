/**
 * The compose draft's `decision` task: a typed judgement about upstream data
 * whose answers enable the tasks routed to them.
 *
 * A decision task is authoring vocabulary, not a runtime task. Parsing a draft
 * expands it into an `ai.decision.decide` operation task plus `when` predicates
 * on the tasks it routes to, so everything after the parse — validators, the
 * assembler, the scheduler — sees only the task kinds it already knows.
 */
import { z } from 'zod';
import {
  DecisionQuestionNameSchema,
  DecisionQuestionsSchema,
  type DecisionQuestion,
  type DecisionQuestions,
} from '../operations/aiDecision.js';
import { DECISION_MODELS, enumWithCustom } from '../operations/enums.js';
import { TEMPLATE_BIND_KEY } from '../operations/workflow/taskTemplate.js';

export const DECISION_OPERATION_ID = 'ai.decision.decide';

const WHEN_EXPRESSION_MAX = 500;

/**
 * A draft task's guard: one comparison, or several joined by `anyOf` / `allOf`.
 */
export const DraftWhenSchema = z.union([
  z.string().max(WHEN_EXPRESSION_MAX),
  z.object({ anyOf: z.array(z.string().max(WHEN_EXPRESSION_MAX)).min(2) }).strict(),
  z.object({ allOf: z.array(z.string().max(WHEN_EXPRESSION_MAX)).min(2) }).strict(),
]);
export type DraftWhen = z.infer<typeof DraftWhenSchema>;

export const DecisionRouteSchema = z
  .object({
    question: DecisionQuestionNameSchema.describe('The question whose answer this route reads.'),
    equals: z
      .union([z.string(), z.boolean()])
      .optional()
      .describe(
        'For a choice: the option label that takes this route. For a yes_no: true or false.',
      ),
    atLeast: z
      .number()
      .optional()
      .describe('For a score: take this route when the expected level is at least this.'),
    below: z
      .number()
      .optional()
      .describe('For a score: take this route when the expected level is below this.'),
    to: z
      .array(z.string().min(1).max(64))
      .min(1)
      .describe(
        'The taskIds this route enables. They run only when the answer matches and was decided; do not give them a when of their own.',
      ),
  })
  .refine(
    (route) =>
      [route.equals, route.atLeast, route.below].filter((value) => value !== undefined).length ===
      1,
    { message: 'A route reads its answer one way: set exactly one of equals, atLeast or below.' },
  );
export type DecisionRoute = z.infer<typeof DecisionRouteSchema>;

export const DecisionTaskFieldsSchema = z.object({
  type: z.literal('decision'),
  taskId: z.string().min(1).max(64),
  questions: DecisionQuestionsSchema.describe(
    'Named questions about the consumed data. Offer only real outcomes as options: uncertainty is not an option — set minConfidence on the question and handle the uncertain case with onUndecided, which uses the model’s calibrated confidence instead of a guessed "unclear" label.',
  ),
  model: enumWithCustom(DECISION_MODELS)
    .optional()
    .describe('Decision model. The platform default when absent.'),
  routes: z
    .array(DecisionRouteSchema)
    .min(1)
    .describe(
      'Which tasks each answer enables. A task a route names runs only when that answer matches; every other routed task is skipped.',
    ),
  onUndecided: z
    .array(z.string().min(1).max(64))
    .default([])
    .describe(
      'Tasks that run when a routed question with a minConfidence is not answered confidently enough — usually an agent task that reasons about the case. Required when any routed question sets minConfidence.',
    ),
  dependsOn: z.array(z.string().max(64)).default([]),
  when: DraftWhenSchema.optional(),
});

export interface DraftTaskLike {
  type: string;
  taskId: string;
  dependsOn: string[];
  when?: DraftWhen | undefined;
}

interface DecisionTaskLike extends DraftTaskLike {
  type: 'decision';
  questions: DecisionQuestions;
  model?: string | undefined;
  routes: DecisionRoute[];
  onUndecided: string[];
  consumes: Array<{ bindAs: string }>;
}

function isDecisionTask(task: DraftTaskLike): task is DecisionTaskLike {
  return task.type === 'decision';
}

// ============================================================================
// Validation
// ============================================================================

function routeIssue(question: DecisionQuestion, route: DecisionRoute): string | null {
  switch (question.type) {
    case 'choice': {
      if (typeof route.equals !== 'string') {
        return `"${route.question}" is a choice, so its route reads it with equals: "<option label>".`;
      }
      if (route.equals.includes("'") && route.equals.includes('"')) {
        return `The option label "${route.equals}" holds both quote characters, so no route can name it. Rename the option.`;
      }
      if (!Object.hasOwn(question.options, route.equals)) {
        return `"${route.question}" offers no option "${route.equals}". Its options are: ${Object.keys(question.options).join(', ')}.`;
      }
      return null;
    }
    case 'yes_no':
      return typeof route.equals === 'boolean'
        ? null
        : `"${route.question}" is a yes_no, so its route reads it with equals: true or equals: false.`;
    case 'score': {
      const threshold = route.atLeast ?? route.below;
      if (threshold === undefined) {
        return `"${route.question}" is a score, so its route reads it with atLeast or below.`;
      }
      const top = question.levels.length - 1;
      if (threshold < 0 || threshold > top) {
        return `"${route.question}" scores from 0 to ${String(top)}; a threshold of ${String(threshold)} can never be crossed.`;
      }
      return null;
    }
  }
}

/**
 * The cross-task rules a decision task's routes must satisfy. Reported as
 * issues on the draft so the author corrects them from the diagnostic.
 */
export function validateDecisionTasks(tasks: readonly DraftTaskLike[], ctx: z.RefinementCtx): void {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const claimed = new Map<string, string>();

  tasks.forEach((task, ti) => {
    if (!isDecisionTask(task)) return;
    const issue = (path: Array<string | number>, message: string) => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tasks', ti, ...path], message });
    };

    const claim = (target: string, path: Array<string | number>, how: string) => {
      const targetTask = byId.get(target);
      if (!targetTask) {
        issue(path, `"${target}" is not a task in this draft.`);
        return;
      }
      if (target === task.taskId) {
        issue(path, `A decision cannot route to itself.`);
        return;
      }
      const previous = claimed.get(target);
      if (previous !== undefined) {
        issue(
          path,
          `"${target}" is already enabled by ${previous}. A task is enabled by one route; add a second task for the second case.`,
        );
        return;
      }
      if (targetTask.when !== undefined) {
        issue(
          path,
          `"${target}" has a when of its own. A routed task is guarded by its route; remove its when.`,
        );
        return;
      }
      claimed.set(target, how);
    };

    const guarded = new Set<string>();
    task.routes.forEach((route, ri) => {
      const question = task.questions[route.question];
      if (!question) {
        issue(
          ['routes', ri, 'question'],
          `"${route.question}" is not one of this decision's questions: ${Object.keys(task.questions).join(', ')}.`,
        );
        return;
      }
      const problem = routeIssue(question, route);
      if (problem) {
        issue(['routes', ri], problem);
        return;
      }
      if (question.minConfidence !== undefined) guarded.add(route.question);
      route.to.forEach((target, i) => {
        claim(target, ['routes', ri, 'to', i], `"${task.taskId}".routes[${String(ri)}]`);
      });
    });

    task.onUndecided.forEach((target, i) => {
      claim(target, ['onUndecided', i], `"${task.taskId}".onUndecided`);
    });

    if (guarded.size > 0 && task.onUndecided.length === 0) {
      issue(
        ['onUndecided'],
        `${[...guarded].map((q) => `"${q}"`).join(', ')} set a minConfidence, so some answers will not be decided. Name the task that handles them in onUndecided.`,
      );
    }
    if (guarded.size === 0 && task.onUndecided.length > 0) {
      issue(
        ['onUndecided'],
        'No routed question sets a minConfidence, so every answer is decided and onUndecided would never run. Set minConfidence on the questions that need a fallback.',
      );
    }
    if (task.consumes.length === 0) {
      issue(
        ['consumes'],
        'A decision reads data: consume at least one run input (e.g. { runInput: "ticket", bindAs: "ticket" }) or upstream output. It becomes the state the questions are asked about.',
      );
    }
  });
}

// ============================================================================
// Expansion
// ============================================================================

function literal(value: string | number | boolean): string {
  if (typeof value !== 'string') return String(value);
  return value.includes("'") ? `"${value}"` : `'${value}'`;
}

function routeComparison(taskId: string, route: DecisionRoute): string {
  const value = `tasks.${taskId}.output.answers.${route.question}.value`;
  if (route.equals !== undefined) return `${value} == ${literal(route.equals)}`;
  if (route.atLeast !== undefined) return `${value} >= ${String(route.atLeast)}`;
  return `${value} < ${String(route.below)}`;
}

function decided(taskId: string, question: string, outcome: boolean): string {
  return `tasks.${taskId}.output.answers.${question}.decided == ${String(outcome)}`;
}

function combine(kind: 'anyOf' | 'allOf', expressions: string[]): DraftWhen {
  return expressions.length === 1
    ? expressions[0]!
    : kind === 'anyOf'
      ? { anyOf: expressions }
      : { allOf: expressions };
}

/**
 * Replace every decision task with the operation task it runs, and give each
 * task it routes to the guard that route implies. Idempotent: a draft with no
 * decision tasks comes back unchanged.
 */
export function expandDecisionTasks<Draft extends { tasks: DraftTaskLike[] }>(
  draft: Draft,
): Omit<Draft, 'tasks'> & { tasks: Array<Exclude<Draft['tasks'][number], { type: 'decision' }>> } {
  type Expanded = Exclude<Draft['tasks'][number], { type: 'decision' }>;
  const guards = new Map<string, { when: DraftWhen; decisionId: string }>();
  for (const task of draft.tasks) {
    if (!isDecisionTask(task)) continue;
    for (const route of task.routes) {
      const question = task.questions[route.question];
      const expressions = [routeComparison(task.taskId, route)];
      if (question?.minConfidence !== undefined) {
        expressions.push(decided(task.taskId, route.question, true));
      }
      for (const target of route.to) {
        guards.set(target, { when: combine('allOf', expressions), decisionId: task.taskId });
      }
    }
    const undecided = [
      ...new Set(
        task.routes
          .filter((r) => task.questions[r.question]?.minConfidence !== undefined)
          .map((r) => r.question),
      ),
    ].map((q) => decided(task.taskId, q, false));
    if (undecided.length > 0) {
      for (const target of task.onUndecided) {
        guards.set(target, { when: combine('anyOf', undecided), decisionId: task.taskId });
      }
    }
  }

  const tasks = draft.tasks.map((task) => {
    if (isDecisionTask(task)) {
      const state = Object.fromEntries(
        task.consumes.map((c) => [c.bindAs, { [TEMPLATE_BIND_KEY]: c.bindAs }]),
      );
      return {
        type: 'operation',
        taskId: task.taskId,
        operationId: DECISION_OPERATION_ID,
        inputBindings: {},
        inputTemplate: {
          state,
          questions: task.questions,
          ...(task.model !== undefined ? { model: task.model } : {}),
        },
        dependsOn: task.dependsOn,
        ...(task.when !== undefined ? { when: task.when } : {}),
        produces: [],
        consumes: task.consumes,
        retryability: 'safe',
      } as unknown as Expanded;
    }
    const guard = guards.get(task.taskId);
    if (!guard) return task as Expanded;
    return {
      ...task,
      when: guard.when,
      dependsOn: [...new Set([...task.dependsOn, guard.decisionId])],
    } as Expanded;
  });

  return { ...draft, tasks };
}
