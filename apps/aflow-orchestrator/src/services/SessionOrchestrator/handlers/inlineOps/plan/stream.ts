import { getDatabase } from '@aflow/database';
import { PlanNodeNextInputSchema } from '@aflow/schemas';
import { createPlanStreamReads, nextInPlanStream } from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepSuccess } from '../helpers.js';
import { emitPlanError, parsePlanInput, planReadContext } from './shared.js';

export async function handlePlanNodeNext(
  args: InlineHandlerArgs,
  startTime: number,
): Promise<void> {
  const input = await parsePlanInput(args, PlanNodeNextInputSchema, startTime);
  if (!input) return;
  const reads = createPlanStreamReads(
    { db: getDatabase(), payloadStore: args.payloadStore },
    args.context.tenantId as string,
  );
  const result = await nextInPlanStream(
    {
      ...planReadContext(args),
      reads,
      redis: args.redis,
      tenantId: args.context.tenantId as string,
      holder: args.context.runId as string,
    },
    input,
  );
  if (!result.ok) {
    await emitPlanError(args, result, startTime);
    return;
  }
  await emitStepSuccess(args, result.output as unknown as Record<string, unknown>, startTime);
}
