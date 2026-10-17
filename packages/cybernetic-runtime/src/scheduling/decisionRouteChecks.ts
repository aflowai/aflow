/**
 * A decision step's routes, checked against the questions it asks.
 *
 * A route that names an option no question offers, or a score past the top of
 * its rubric, compiles and then never fires; checking it here turns a branch
 * that silently goes nowhere into a diagnostic naming the options that exist.
 */
import { predicateExpressions, type WorkflowTask } from '@aflow/schemas';
import { parseOutputComparison } from './graph.js';
import type { GraphValidationError } from './graphValidation.js';

interface QuestionShape {
  type?: unknown;
  options?: unknown;
  levels?: unknown;
}

function literalQuestions(task: WorkflowTask): Record<string, QuestionShape> | undefined {
  const source = task.inputTemplate ?? task.inputs;
  const questions = source?.['questions'];
  return questions !== null && typeof questions === 'object' && !Array.isArray(questions)
    ? (questions as Record<string, QuestionShape>)
    : undefined;
}

export function checkDecisionRoutes(task: WorkflowTask): GraphValidationError[] {
  const questions = literalQuestions(task);
  if (!questions) return [];
  const errors: GraphValidationError[] = [];

  (task.routes ?? []).forEach((route, ri) => {
    const field = `routes[${String(ri)}].when`;
    for (const expression of predicateExpressions(route.when)) {
      const parsed = parseOutputComparison(expression.trim());
      const [answers, name, property] = parsed?.field.split('.') ?? [];
      if (!parsed || answers !== 'answers' || name === undefined) continue;
      const question = questions[name];
      if (!question) {
        errors.push({
          kind: 'route_decision_unknown_question',
          taskIds: [task.taskId],
          field,
          detail: `Task "${task.taskId}" routes on "${name}", which is not one of its questions: ${Object.keys(questions).join(', ')}.`,
        });
        continue;
      }
      if (property !== 'value') continue;
      const rhs = parsed.rhs.value;
      if (question.type === 'choice' && question.options && typeof question.options === 'object') {
        const options = Object.keys(question.options);
        if (typeof rhs !== 'string' || !options.includes(rhs)) {
          errors.push({
            kind: 'route_decision_unknown_option',
            taskIds: [task.taskId],
            field,
            detail: `Task "${task.taskId}" routes on "${name}" == ${JSON.stringify(rhs)}, which "${name}" never answers. Its options are: ${options.join(', ')}.`,
          });
        }
      } else if (question.type === 'yes_no' && typeof rhs !== 'boolean') {
        errors.push({
          kind: 'route_decision_unknown_option',
          taskIds: [task.taskId],
          field,
          detail: `Task "${task.taskId}" routes on "${name}", a yes_no, compared with ${JSON.stringify(rhs)}; compare it with true or false.`,
        });
      } else if (question.type === 'score' && Array.isArray(question.levels)) {
        const top = question.levels.length - 1;
        if (typeof rhs !== 'number' || rhs < 0 || rhs > top) {
          errors.push({
            kind: 'route_decision_threshold_out_of_range',
            taskIds: [task.taskId],
            field,
            detail: `Task "${task.taskId}" routes on "${name}" against ${JSON.stringify(rhs)}, but "${name}" scores from 0 to ${String(top)}.`,
          });
        }
      }
    }
  });
  return errors;
}
