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

export const WorkflowRunDecideRuleSchema = z
  .object({
    when: WorkflowRunDecideRuleWhenSchema,
    decision: DecisionLabelSchema,
    reason: DecisionReasonSchema,
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
    .object({ decision: DecisionLabelSchema, reason: DecisionReasonSchema })
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
});
export type WorkflowRunDecideOutput = z.infer<typeof WorkflowRunDecideOutputSchema>;
