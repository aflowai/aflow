import type { DecisionAnswer, DecisionQuestions } from '@aflow/schemas';
import type { ProviderDecisionAnswer } from './types.js';
import { AIClientError } from './errors.js';

/**
 * A provider's answers read against the questions that were asked: each one
 * typed as the operation reports it, with `decided` set by the question's own
 * `minConfidence`.
 *
 * A yes/no carries no confidence of its own, so its confidence is the
 * probability of the more likely outcome. That makes one threshold mean the
 * same thing on every question type.
 *
 * An answer whose type differs from its question, or a choice outside the
 * options offered, is refused rather than passed on: a workflow routes on these
 * values, and a label nothing routes on would silently skip every branch.
 */
export function resolveDecisionAnswers(
  questions: DecisionQuestions,
  answers: Readonly<Record<string, ProviderDecisionAnswer>>,
): Record<string, DecisionAnswer> {
  const resolved: Record<string, DecisionAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = answers[name];
    if (answer === undefined) {
      throw mismatch(`no answer was returned for "${name}"`);
    }
    if (answer.type !== question.type) {
      throw mismatch(`"${name}" asked a ${question.type} question and got a ${answer.type} answer`);
    }
    const clears = (confidence: number) =>
      question.minConfidence === undefined || confidence >= question.minConfidence;

    switch (answer.type) {
      case 'choice': {
        if (question.type !== 'choice' || !Object.hasOwn(question.options, answer.choice)) {
          throw mismatch(`"${name}" chose "${answer.choice}", which is not one of its options`);
        }
        resolved[name] = {
          type: 'choice',
          value: answer.choice,
          confidence: answer.confidence,
          probabilities: answer.probabilities,
          decided: clears(answer.confidence),
        };
        break;
      }
      case 'score': {
        resolved[name] = {
          type: 'score',
          value: answer.score,
          confidence: answer.confidence,
          probabilities: answer.probabilities,
          decided: clears(answer.confidence),
        };
        break;
      }
      case 'yes_no': {
        const confidence = Math.max(answer.probability, 1 - answer.probability);
        resolved[name] = {
          type: 'yes_no',
          value: answer.probability >= 0.5,
          probability: answer.probability,
          confidence,
          decided: clears(confidence),
        };
        break;
      }
    }
  }
  return resolved;
}

function mismatch(detail: string): AIClientError {
  return new AIClientError(
    `The decision model's answer does not fit the question: ${detail}`,
    'provider_error',
    undefined,
    false,
  );
}
