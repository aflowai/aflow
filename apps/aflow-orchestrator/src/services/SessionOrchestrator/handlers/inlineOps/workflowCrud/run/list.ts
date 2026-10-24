import { getDatabase } from '@aflow/database';
import { WorkflowRunListInputSchema } from '@aflow/schemas';
import type { InlineHandlerArgs } from '../../types.js';
import { emitStepError, emitStepSuccess } from '../../helpers.js';
import { requireSpaceId } from '../../spaceScope.js';

export async function handleWorkflowRunList(
  args: InlineHandlerArgs,
  input: unknown,
  startTime: number,
): Promise<void> {
  const parsed = WorkflowRunListInputSchema.safeParse(input);
  if (!parsed.success) {
    await emitStepError(
      args,
      'WORKFLOW_RUN_LIST_INPUT_INVALID',
      parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '),
      startTime,
      'validation',
    );
    return;
  }
  const spaceId = requireSpaceId(args.context);
  const { listRunsByInput } = await import('@aflow/cybernetic-runtime');
  const output = await listRunsByInput({
    db: getDatabase(),
    tenantId: args.context.tenantId as string,
    spaceId,
    sessionId: args.context.runId,
    query: parsed.data,
    payloadStore: args.payloadStore,
  });
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}
