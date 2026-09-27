/**
 * ai.decision.decide — typed decisions about a state, answered by a decision
 * model rather than generated as text.
 */
import { z } from 'zod';
import { TokenUsageSchema } from './aiUsage.js';
import { DECISION_MODELS, enumWithCustom } from './enums.js';

/**
 * What a decision model reads: text, a JSON object or a JSON array. The same
 * shape serves a question's instructions and each option's description.
 */
export const DecisionEntrySchema = z.union([
  z.string(),
  z.record(z.unknown()),
  z.array(z.unknown()),
]);
export type DecisionEntry = z.infer<typeof DecisionEntrySchema>;

/**
 * A question's name is also the path a workflow reads its answer under
 * (`tasks.<id>.output.answers.<name>.value`), so it is held to the characters
 * a predicate path can carry.
 */
export const DecisionQuestionNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,63}$/,
    'A question name is lowercase letters, digits and underscores, starting with a letter — it becomes the path answers.<name> in the output.',
  );

export const DECISION_MAX_CHOICE_OPTIONS = 255;
export const DECISION_MIN_SCORE_LEVELS = 2;
export const DECISION_MAX_SCORE_LEVELS = 10;

const minConfidenceSchema = z
  .number()
  .min(0)
  .max(1)
  .describe(
    'Below this confidence the answer is returned with decided=false instead of being acted on. Route the undecided case to a step that can reason about it.',
  );

const instructionsSchema = DecisionEntrySchema.describe(
  'What is being decided about the state, stated as literally as it should be read. Negations and scope apply exactly as written.',
);

export const DecisionChoiceQuestionSchema = z.object({
  type: z.literal('choice'),
  instructions: instructionsSchema.optional(),
  options: z
    .record(z.string().min(1).max(128), DecisionEntrySchema.nullable())
    .refine(
      (options) => {
        const count = Object.keys(options).length;
        return count >= 2 && count <= DECISION_MAX_CHOICE_OPTIONS;
      },
      {
        message: `A choice offers between 2 and ${String(DECISION_MAX_CHOICE_OPTIONS)} options.`,
      },
    )
    .describe(
      'Option label → what the option means. The answer is one of these labels; describe each well enough that a reader could pick it without seeing the others.',
    ),
  minConfidence: minConfidenceSchema.optional(),
});

export const DecisionScoreQuestionSchema = z.object({
  type: z.literal('score'),
  instructions: instructionsSchema.optional(),
  levels: z
    .array(DecisionEntrySchema.nullable())
    .min(DECISION_MIN_SCORE_LEVELS)
    .max(DECISION_MAX_SCORE_LEVELS)
    .describe(
      'The rubric, lowest first. The answer is the expected level index, which may fall between two levels.',
    ),
  minConfidence: minConfidenceSchema.optional(),
});

export const DecisionYesNoQuestionSchema = z.object({
  type: z.literal('yes_no'),
  instructions: instructionsSchema.optional(),
  criteria: z
    .object({
      true: DecisionEntrySchema.nullable().optional(),
      false: DecisionEntrySchema.nullable().optional(),
    })
    .describe('Optional descriptions of what makes the statement true and what makes it false.')
    .optional(),
  minConfidence: minConfidenceSchema.optional(),
});

export const DecisionQuestionSchema = z.discriminatedUnion('type', [
  DecisionChoiceQuestionSchema,
  DecisionScoreQuestionSchema,
  DecisionYesNoQuestionSchema,
]);
export type DecisionQuestion = z.infer<typeof DecisionQuestionSchema>;

export const DecisionQuestionsSchema = z
  .record(DecisionQuestionNameSchema, DecisionQuestionSchema)
  .refine((questions) => Object.keys(questions).length > 0, {
    message: 'Ask at least one question.',
  })
  .describe(
    'Named questions, all answered in one pass and each in isolation — one question cannot see another’s answer.',
  );
export type DecisionQuestions = z.infer<typeof DecisionQuestionsSchema>;

export const AiDecideInputSchema = z.object({
  state: DecisionEntrySchema.describe(
    'What the questions are about: text, a JSON object or a JSON array. Content in the state can steer the answers, so a decision about untrusted input is never the only gate on something that matters.',
  ),
  questions: DecisionQuestionsSchema,
  model: enumWithCustom(DECISION_MODELS)
    .describe('Decision model to use. The platform default when absent.')
    .optional(),
});
export type AiDecideInput = z.infer<typeof AiDecideInputSchema>;

const decidedSchema = z
  .boolean()
  .describe(
    'False when confidence fell below the question’s minConfidence. The value is still the most likely answer.',
  );

const probabilitiesSchema = z.record(z.string(), z.number().min(0).max(1));

export const DecisionChoiceAnswerSchema = z.object({
  type: z.literal('choice'),
  value: z.string().describe('The chosen option label.'),
  confidence: z.number().min(0).max(1),
  probabilities: probabilitiesSchema.describe('Option label → probability.'),
  decided: decidedSchema,
});

export const DecisionScoreAnswerSchema = z.object({
  type: z.literal('score'),
  value: z.number().describe('The expected level index, lowest level 0; may be fractional.'),
  confidence: z.number().min(0).max(1),
  probabilities: probabilitiesSchema.describe('Level index → probability.'),
  decided: decidedSchema,
});

export const DecisionYesNoAnswerSchema = z.object({
  type: z.literal('yes_no'),
  value: z.boolean().describe('True when the statement is more likely true than false.'),
  probability: z.number().min(0).max(1).describe('Probability that the statement is true.'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('Probability of the more likely outcome: max(probability, 1 − probability).'),
  decided: decidedSchema,
});

export const DecisionAnswerSchema = z.discriminatedUnion('type', [
  DecisionChoiceAnswerSchema,
  DecisionScoreAnswerSchema,
  DecisionYesNoAnswerSchema,
]);
export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>;

export const AiDecideOutputSchema = z.object({
  answers: z.record(z.string(), DecisionAnswerSchema).describe('Question name → answer.'),
  model: z.string(),
  usage: TokenUsageSchema,
  latencyMs: z.number().int().nonnegative(),
});
export type AiDecideOutput = z.infer<typeof AiDecideOutputSchema>;
