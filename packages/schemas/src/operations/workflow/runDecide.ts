import { z } from 'zod';

// --- workflow.run.decide ---

/**
 * One comparison of a rule: `state.<path> <op> <literal>`, or
 * `state.<path> <op> state.<path>` to compare two values of the state. The
 * same comparisons a task's `when` makes, over the state the step is handed,
 * with one addition: the right side may name another value, which a `when`
 * over one task's output never needs and a decision over several reads does.
 */
const RuleComparisonSchema = z.string().min(1).max(500);
const RuleComparisonListSchema = z.array(RuleComparisonSchema).min(1).max(10);

export const WorkflowRunDecideRuleWhenSchema = z.union([
  z.object({ expression: RuleComparisonSchema }).strict(),
  z.object({ anyOf: RuleComparisonListSchema }).strict(),
  z.object({ allOf: RuleComparisonListSchema }).strict(),
]);
export type WorkflowRunDecideRuleWhen = z.infer<typeof WorkflowRunDecideRuleWhenSchema>;

const DecisionLabelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, { message: 'A decision is a lowercase label: `wait`, `fix`.' });

/** Room for a sentence a person reads on the pull request, not a style limit. */
const DecisionReasonSchema = z.string().min(1).max(4000);

/**
 * A value the decision hands on beside its label — a number, a text or an
 * object a label cannot be. A task template substitutes whole nodes and cannot
 * pick a value per decision, so a value that follows the decision is named on
 * the rule and a later task binds it, or a path into it, from the output,
 * absent where the rule names none: an object lets one decision add several
 * inputs to a later operation, such as a harness run's `browser` and
 * `preview`, without a second task written for each branch.
 */
const DECISION_TEXT_MAX = 4000;

/**
 * An object value is bounded by its JSON as UTF-8, sized to the text form's
 * worst case — four bytes for each of its characters — so an object holding a
 * text of that length and a few inputs beside it fits, and a rule cannot hand
 * on anything larger through the decision's output.
 */
export const DECISION_OBJECT_VALUE_MAX_BYTES = 4 * DECISION_TEXT_MAX;

const utf8 = new TextEncoder();

const DecisionObjectValueSchema = z.record(z.unknown()).refine(
  (value) => {
    try {
      return utf8.encode(JSON.stringify(value)).length <= DECISION_OBJECT_VALUE_MAX_BYTES;
    } catch {
      return false;
    }
  },
  {
    message: `An object value serializes to at most ${String(DECISION_OBJECT_VALUE_MAX_BYTES)} bytes of JSON. Carry a large value in the state a later task reads instead.`,
  },
);

const DecisionValueSchema = z.union([
  z.string().max(DECISION_TEXT_MAX),
  z.number(),
  z.boolean(),
  DecisionObjectValueSchema,
]);

export const WorkflowRunDecideRuleSchema = z
  .object({
    when: WorkflowRunDecideRuleWhenSchema,
    decision: DecisionLabelSchema,
    reason: DecisionReasonSchema,
    value: DecisionValueSchema.optional(),
  })
  .strict();
export type WorkflowRunDecideRule = z.infer<typeof WorkflowRunDecideRuleSchema>;

export const WorkflowRunDecideInputSchema = z.object({
  state: z
    .record(z.unknown())
    .describe(
      "What the rules read, bound from earlier tasks' outputs. A value an upstream task did not produce is absent, and a path through an absent value reads as `null` — so `state.pr == null` is how a rule names a read that did not happen.",
    ),
  rules: z
    .array(WorkflowRunDecideRuleSchema)
    .min(1)
    .max(50)
    .describe('Read in order; the first whose `when` holds decides.'),
  otherwise: z
    .object({
      decision: DecisionLabelSchema,
      reason: DecisionReasonSchema,
      value: DecisionValueSchema.optional(),
    })
    .strict()
    .describe('The decision when no rule holds.'),
});
export type WorkflowRunDecideInput = z.infer<typeof WorkflowRunDecideInputSchema>;

export const WorkflowRunDecideOutputSchema = z.object({
  decision: z.string().describe('The label of the rule that held, or `otherwise`’s.'),
  reason: z.string().describe('That rule’s reason, as written.'),
  rule: z
    .number()
    .int()
    .min(0)
    .nullable()
    .describe('The index of the rule that held; null where none did and `otherwise` decided.'),
  value: DecisionValueSchema.optional().describe(
    'The value the rule that held names beside its decision; absent where it names none.',
  ),
});
export type WorkflowRunDecideOutput = z.infer<typeof WorkflowRunDecideOutputSchema>;
