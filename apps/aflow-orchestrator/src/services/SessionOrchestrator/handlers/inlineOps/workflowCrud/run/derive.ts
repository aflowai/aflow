import {
  getRunDeriver,
  WorkflowRunDeriveInputSchema,
  type WorkflowRunDeriveOutput,
} from '@aflow/schemas';
import type { InlineHandlerArgs } from '../../types.js';
import { emitStepError, emitStepSuccess } from '../../helpers.js';

/**
 * Run the deriver the call names over the arguments it was handed. A deriver
 * is pure, so its refusal fails the step as a validation error: the same
 * arguments would be refused again.
 */
export async function handleWorkflowRunDerive(
  args: InlineHandlerArgs,
  input: unknown,
  startTime: number,
): Promise<void> {
  const parsed = WorkflowRunDeriveInputSchema.safeParse(input);
  if (!parsed.success) {
    await emitStepError(
      args,
      'WORKFLOW_RUN_DERIVE_INPUT_INVALID',
      parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '),
      startTime,
      'validation',
    );
    return;
  }
  const deriver = getRunDeriver(parsed.data.deriver);
  if (!deriver) {
    await emitStepError(
      args,
      'WORKFLOW_RUN_DERIVER_UNKNOWN',
      `No run deriver is registered as "${parsed.data.deriver}".`,
      startTime,
      'validation',
    );
    return;
  }
  const result = deriver(parsed.data.args);
  if (!result.ok) {
    await emitStepError(
      args,
      'WORKFLOW_RUN_DERIVE_REFUSED',
      result.message,
      startTime,
      'validation',
    );
    return;
  }
  const output: WorkflowRunDeriveOutput = { deriver: parsed.data.deriver, value: result.value };
  await emitStepSuccess(args, output, startTime);
}
