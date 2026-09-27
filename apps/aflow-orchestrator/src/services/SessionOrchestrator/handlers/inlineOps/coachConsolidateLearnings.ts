import { randomUUID } from 'node:crypto';
import { getDatabase } from '@aflow/database';
import type { LearnerLearningConsolidateInput } from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';

export async function handleConsolidateLearnings(
  args: InlineHandlerArgs,
  input: LearnerLearningConsolidateInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const db = getDatabase();
  const { consolidateCoachLearnings } = await import('@aflow/cybernetic-runtime');

  const applied = await consolidateCoachLearnings(db, args.context.tenantId as string, {
    spaceId,
    resolvedBy: args.context.runId,
    actions: input.actions,
  });

  const countFor = (action: string): number =>
    applied.filter((r) => r.action === action && r.ok).length;
  const failedCount = applied.filter((r) => !r.ok).length;

  try {
    const { appendEntityEvent } = await import('@aflow/redis');
    await appendEntityEvent(args.redis, {
      tenantId: args.context.tenantId,
      spaceId,
      event: {
        eventId: randomUUID(),
        eventType: 'entity.coach.consolidation',
        spaceId,
        tenantId: args.context.tenantId,
        timestamp: Date.now(),
        causedBySessionId: args.context.runId,
        causedByStepExecutionId: args.stepExecutionId,
        operatingMode: 'supervisory',
        payload: {
          mergedCount: countFor('merge'),
          retiredCount: countFor('retire'),
          disprovenCount: countFor('disprove'),
          prunedCount: countFor('prune'),
          failedCount,
        },
        summary: `Coach consolidated learnings (${applied.length - failedCount} of ${applied.length} actions applied)`,
      },
    });
  } catch {
    // best-effort
  }

  await emitStepSuccess(args, { applied }, startTime);
}
