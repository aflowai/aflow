import { randomUUID } from 'node:crypto';
import { getDatabase } from '@aflow/database';
import type { LearnerProposeWorkflowChangeInput } from '@aflow/schemas';
import { persistObservation } from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';

/**
 * Downgrade path for a graph/goal/task edit whose warrant asserts an inferred
 * cause with no confirmation step: record it as an observation and return a
 * result that visibly explains the downgrade and carries the confirmation ask.
 * Never a hard reject (loops the Coach), never a silent swap (untraceable).
 */
export async function routeInferredCauseToObservation(
  args: InlineHandlerArgs,
  input: LearnerProposeWorkflowChangeInput,
  explanation: string,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const db = getDatabase();

  const stateVars = (args.context as { stateVariables?: Record<string, unknown> }).stateVariables;
  const runId =
    typeof stateVars?.['run_id'] === 'string'
      ? stateVars['run_id']
      : (input.evidence.sourceSessionIds[0] ?? 'unknown');

  const claim = input.evidence.warrant?.claim ?? input.rationale;
  const summary = `Inferred cause, unconfirmed — proposed change withheld: ${claim}`.slice(0, 500);

  try {
    const result = await persistObservation({
      db,
      tenantId: args.context.tenantId as string,
      spaceId,
      coachSessionId: args.context.runId,
      workflowSlug: input.targetSlug,
      runId,
      reason: 'other',
      summary,
      detail: explanation,
    });

    try {
      const { appendEntityEvent } = await import('@aflow/redis');
      await appendEntityEvent(args.redis, {
        tenantId: args.context.tenantId,
        spaceId,
        event: {
          eventId: randomUUID(),
          eventType: 'entity.coach.suppressed',
          spaceId,
          tenantId: args.context.tenantId,
          timestamp: Date.now(),
          causedBySessionId: args.context.runId,
          causedByStepExecutionId: args.stepExecutionId,
          workflowSlug: input.targetSlug,
          operatingMode: 'supervisory',
          payload: {
            reason: 'inferred_cause_unconfirmed',
            observationId: result.observationId,
          },
          summary: `Proposal for "${input.targetSlug}" recorded as an observation — inferred cause without a confirmation step`,
        },
      });
    } catch {
      // best-effort telemetry
    }

    await emitStepSuccess(
      args,
      {
        downgradedFrom: 'workflow_change',
        recordedAs: 'observation_only',
        observationId: result.observationId,
        observationRef: result.observationRef,
        reason: explanation,
        confirmation: input.evidence.warrant?.confirmation ?? null,
      },
      startTime,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emitStepError(args, 'OBSERVATION_RECORD_FAILED', message, startTime, 'internal');
  }
}
