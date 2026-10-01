import { getDatabase } from '@aflow/database';
import { WorkflowRunLatestInputSchema, type WorkflowRunLatestInput } from '@aflow/schemas';
import type { InlineHandlerArgs } from '../../types.js';
import { emitStepError, emitStepSuccess } from '../../helpers.js';
import { requireSpaceId } from '../../spaceScope.js';

export async function handleWorkflowRunLatest(
  args: InlineHandlerArgs,
  input: WorkflowRunLatestInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  // A match on a value that never arrived would read as "no such run", which
  // a publication treats as unreviewed; refusing says what was wrong instead.
  const parsed = WorkflowRunLatestInputSchema.safeParse(input);
  if (!parsed.success) {
    await emitStepError(
      args,
      'INVALID_INPUT',
      `workflow.run.latest: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      startTime,
      'validation',
    );
    return;
  }

  const { findLatestCompletedRun } = await import('@aflow/cybernetic-runtime');
  const output = await findLatestCompletedRun(
    { db: getDatabase(), payloadStore: args.payloadStore },
    { tenantId: args.context.tenantId as string, spaceId, input: parsed.data },
  );
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}
