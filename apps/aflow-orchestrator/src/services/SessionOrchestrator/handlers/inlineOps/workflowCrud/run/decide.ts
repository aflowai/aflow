import { WorkflowRunDecideInputSchema } from '@aflow/schemas';
import { decideByRules, RuleDecisionError } from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from '../../types.js';
import { emitStepError, emitStepSuccess } from '../../helpers.js';

/**
 * A rule the grammar refuses fails the step as a validation error: it is the
 * skill's to correct, and the same state would be refused again.
 */
export async function handleWorkflowRunDecide(
  args: InlineHandlerArgs,
  input: unknown,
  startTime: number,
): Promise<void> {
  const parsed = WorkflowRunDecideInputSchema.safeParse(input);
  if (!parsed.success) {
    await emitStepError(
      args,
      'WORKFLOW_RUN_DECIDE_INPUT_INVALID',
      parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '),
      startTime,
      'validation',
    );
    return;
  }
  let output;
  try {
    output = decideByRules(parsed.data);
  } catch (err) {
    if (err instanceof RuleDecisionError) {
      await emitStepError(
        args,
        'WORKFLOW_RUN_DECIDE_RULE_INVALID',
        err.message,
        startTime,
        'validation',
      );
      return;
    }
    throw err;
  }
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}
