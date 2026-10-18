/**
 * ai.decision.decide — typed decisions about a state, answered by a decision
 * model rather than generated as text.
 */
import { z } from 'zod';
import { TokenUsageSchema } from './aiUsage.js';
import { DECISION_MODELS, enumWithCustom } from './enums.js';
import { MediaSourceRefSchema } from './mediaSourceRef.js';

/** The most images one decision may read, the provider limit across a request. */
export const DECISION_MAX_IMAGES = 128;

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
  .superRefine((questions, ctx) => {
    for (const [name, q] of Object.entries(questions)) {
      if (q.type !== 'yes_no' || q.instructions !== undefined) continue;
      if (q.criteria?.true != null || q.criteria?.false != null) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message:
          'A yes_no question states the claim it asks about: give instructions, or criteria for true or false.',
      });
    }
  })
  .describe(
    'Named questions, all answered in one pass and each in isolation — one question cannot see another’s answer.',
  );
export type DecisionQuestions = z.infer<typeof DecisionQuestionsSchema>;

/** The most items one `each` asks about: a review returns at most this many findings. */
export const DECISION_MAX_EACH_ITEMS = 50;

/**
 * The name an `each` item's question travels under beside the named questions.
 * A named question may not take it, so the two can never answer for each other.
 */
export const DECISION_EACH_QUESTION_PREFIX = 'each_';
const EACH_QUESTION_NAME = /^each_\d+$/;

export function decisionEachQuestionName(index: number): string {
  return `${DECISION_EACH_QUESTION_PREFIX}${String(index)}`;
}

export const DecisionEachSchema = z
  .object({
    items: z
      .array(DecisionEntrySchema)
      .max(DECISION_MAX_EACH_ITEMS)
      .describe(
        "The list the question is asked of, one item at a time — the findings of a review, the lines of an order — each text, a JSON object or a JSON array, as a question's instructions are, since it is read as part of them beside the state. An empty list selects nothing, and with no named questions beside it nothing is asked.",
      ),
    question: DecisionYesNoQuestionSchema.describe(
      'The yes_no asked of every item, stated about one item. Its minConfidence holds for each answer.',
    ),
  })
  .superRefine((each, ctx) => {
    const q = each.question;
    if (q.instructions !== undefined || q.criteria?.true != null || q.criteria?.false != null) {
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['question'],
      message:
        'A yes_no question states the claim it asks about: give instructions, or criteria for true or false.',
    });
  });
export type DecisionEach = z.infer<typeof DecisionEachSchema>;

export const AiDecideInputSchema = z
  .object({
    state: DecisionEntrySchema.describe(
      'What the questions are about: text, a JSON object or a JSON array. Content in the state can steer the answers, so a decision about untrusted input is never the only gate on something that matters.',
    ),
    images: z
      .array(MediaSourceRefSchema)
      .min(1)
      .max(DECISION_MAX_IMAGES)
      .describe(
        'Images the questions are also about — screenshots, photos, documents — read with the state. Only a decision model that reads images takes them; a step that sends images to one that does not is refused.',
      )
      .optional(),
    questions: DecisionQuestionsSchema.optional(),
    each: DecisionEachSchema.optional().describe(
      'One yes_no asked of every item of a list, for a list whose length is known only when the step runs. The items it holds true for, confidently, come back as `each.selected` — and as `each.selectedJson`, text a later step can hand on.',
    ),
    model: enumWithCustom(DECISION_MODELS)
      .describe(
        "Decision model to use. Absent, the space's decision model, or the first decision model whose provider the space holds a key for.",
      )
      .optional(),
  })
  .superRefine((input, ctx) => {
    if (input.questions === undefined && input.each === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['questions'],
        message: 'Ask named questions, a question of each item, or both.',
      });
    }
    if (input.each === undefined) return;
    for (const name of Object.keys(input.questions ?? {})) {
      if (!EACH_QUESTION_NAME.test(name)) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['questions', name],
        message: `"${name}" is how an item of \`each\` is asked; name the question otherwise.`,
      });
    }
  });
export type AiDecideInput = z.infer<typeof AiDecideInputSchema>;

const decidedSchema = z
  .boolean()
  .describe(
    'False when confidence fell below the question’s minConfidence. The value is still the most likely answer.',
  );

const probabilitiesSchema = z.record(z.string(), z.number().min(0).max(1));

/**
 * One comparison a route can read: `decidedValue == 'billing'` holds only
 * for an answer that is billing and cleared the bar, which a predicate that
 * can join comparisons only one level deep could otherwise say only as an
 * `allOf` — and so never beside another condition in an `anyOf`.
 */
const decidedValueDescription =
  'The value where the answer cleared the question’s minConfidence; null where it did not.';

export const DecisionChoiceAnswerSchema = z.object({
  type: z.literal('choice'),
  value: z.string().describe('The chosen option label.'),
  decidedValue: z.string().nullable().describe(decidedValueDescription),
  confidence: z.number().min(0).max(1),
  probabilities: probabilitiesSchema.describe('Option label → probability.'),
  decided: decidedSchema,
});

export const DecisionScoreAnswerSchema = z.object({
  type: z.literal('score'),
  value: z.number().describe('The expected level index, lowest level 0; may be fractional.'),
  decidedValue: z.number().nullable().describe(decidedValueDescription),
  confidence: z.number().min(0).max(1),
  probabilities: probabilitiesSchema.describe('Level index → probability.'),
  decided: decidedSchema,
});

export const DecisionYesNoAnswerSchema = z.object({
  type: z.literal('yes_no'),
  value: z.boolean().describe('True when the statement is more likely true than false.'),
  decidedValue: z.boolean().nullable().describe(decidedValueDescription),
  probability: z.number().min(0).max(1).describe('Probability that the statement is true.'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('Probability of the more likely outcome: max(probability, 1 − probability).'),
  decided: decidedSchema,
});

export const DecisionRefusalAnswerSchema = z.object({
  type: z.literal('refusal'),
  decidedValue: z
    .null()
    .describe(`${decidedValueDescription} A refusal never clears it, so it is always null here.`),
  decided: z
    .literal(false)
    .describe(
      'The model declined this question; it is never decided. A route on decided == false takes it.',
    ),
});

export const DecisionAnswerSchema = z.discriminatedUnion('type', [
  DecisionChoiceAnswerSchema,
  DecisionScoreAnswerSchema,
  DecisionYesNoAnswerSchema,
  DecisionRefusalAnswerSchema,
]);
export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>;

/** An item's answer: the yes_no asked of it, or a refusal where the model declined that item. */
export const DecisionEachAnswerSchema = z.discriminatedUnion('type', [
  DecisionYesNoAnswerSchema,
  DecisionRefusalAnswerSchema,
]);
export type DecisionEachAnswer = z.infer<typeof DecisionEachAnswerSchema>;

export const DecisionEachOutputSchema = z.object({
  answers: z
    .array(DecisionEachAnswerSchema)
    .describe(
      'The answer for each item, in the order the items were given. An item the model declined is a refusal, never decided, so never selected.',
    ),
  selected: z
    .array(z.unknown())
    .describe('The items whose answer is true and decided, in their order.'),
  selectedCount: z.number().int().nonnegative(),
  undecidedCount: z
    .number()
    .int()
    .nonnegative()
    .describe('How many items were answered below the question’s minConfidence, or declined.'),
  selectedJson: z
    .string()
    .describe(
      '`selected` as indented JSON, for a step that takes text — a brief, a message. `[]` where none was selected.',
    ),
});
export type DecisionEachOutput = z.infer<typeof DecisionEachOutputSchema>;

/** The model an answer reports where no model was asked anything. */
export const DECISION_NO_MODEL = 'none';

export const AiDecideOutputSchema = z.object({
  answers: z
    .record(z.string(), DecisionAnswerSchema)
    .describe('Question name → answer. Empty where only `each` was asked.'),
  each: DecisionEachOutputSchema.optional().describe('Present where `each` was asked.'),
  model: z
    .string()
    .describe(
      `The decision model that answered — or \`${DECISION_NO_MODEL}\` where nothing was asked of one, as for an \`each\` over an empty list with no named question beside it.`,
    ),
  calibration: z
    .enum(['calibrated', 'self_reported'])
    .describe(
      "Whether this model's confidence tracks how often it is right. Self-reported confidence makes a minConfidence threshold a guess until it is measured against labelled examples.",
    ),
  usage: TokenUsageSchema,
  latencyMs: z.number().int().nonnegative(),
});
export type AiDecideOutput = z.infer<typeof AiDecideOutputSchema>;
