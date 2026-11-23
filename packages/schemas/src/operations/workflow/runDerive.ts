import { z } from 'zod';

// --- workflow.run.derive ---

export const WorkflowRunDeriveInputSchema = z.object({
  deriver: z
    .string()
    .min(1)
    .max(120)
    .describe('A deriver registered by name, such as `trading.market-regime`.'),
  args: z
    .record(z.string().min(1).max(64), z.unknown())
    .default({})
    .describe(
      "What the deriver computes from, bound from earlier tasks' outputs. A value an upstream task did not produce is absent, and the deriver refuses an argument it needs and lacks.",
    ),
});
export type WorkflowRunDeriveInput = z.infer<typeof WorkflowRunDeriveInputSchema>;

export const WorkflowRunDeriveOutputSchema = z.object({
  deriver: z.string().describe('The deriver that computed the value.'),
  value: z.record(z.unknown()).describe('What the deriver computed from its arguments.'),
});
export type WorkflowRunDeriveOutput = z.infer<typeof WorkflowRunDeriveOutputSchema>;
