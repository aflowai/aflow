import type { AiToolResultEnvelopeV1 } from '@aflow/schemas';
import { MAX_NEXT_STEPS } from '@aflow/schemas';
import type { ToolResultSummary } from '../types.js';

export function buildToolResultEnvelopes(
  results: ToolResultSummary[],
  completedAtMs: number,
): AiToolResultEnvelopeV1[] {
  return results.map((tr) => ({
    kind: 'tool_result' as const,
    toolCallId: tr.toolCallId,
    toolName: tr.name,
    ...(tr.operationId ? { operationId: tr.operationId } : {}),
    status: tr.status,
    ...(tr.durationMs !== undefined ? { durationMs: tr.durationMs } : {}),
    completedAtMs,
    ...(tr.displayedToUser !== undefined ? { displayedToUser: tr.displayedToUser } : {}),
    ...(tr.outputStoredIn && tr.outputStoredIn.length > 0
      ? {
          wroteVariables: tr.outputStoredIn.map((key) => ({
            variableKey: key,
            ...(tr.displayedToUser !== undefined ? { displayedToUser: tr.displayedToUser } : {}),
          })),
        }
      : {}),
    ...(tr.hasOutputRef ? { outputPath: `/run/outputs/${tr.toolCallId}` } : {}),
    ...(tr.outputFields && tr.outputFields.length > 0 ? { outputFields: tr.outputFields } : {}),
    ...(tr.error ? { error: tr.error } : {}),
    ...(!tr.error && tr.summary !== undefined ? { summary: tr.summary } : {}),
    ...(tr.nextSteps && tr.nextSteps.length > 0
      ? { nextSteps: tr.nextSteps.slice(0, MAX_NEXT_STEPS) }
      : {}),
    ...(tr.images && tr.images.length > 0 ? { images: tr.images } : {}),
    // Error-type-aware recovery hint for the agent.
    ...(tr.status === 'FAILED'
      ? {
          nextExpectedFromAgent: [
            {
              action:
                tr.error?.error === 'permission' ||
                tr.error?.error === 'configuration' ||
                tr.error?.retry === false
                  ? 'pause_for_input'
                  : 'retry',
              note:
                tr.error?.error === 'permission'
                  ? 'This operation is not available to you in this session. Do NOT retry it. Use a different operation or inform the user that this capability is not currently enabled.'
                  : tr.error?.error === 'configuration'
                    ? 'This operation is misconfigured. Do NOT retry — inform the user about the configuration issue.'
                    : tr.error?.retry === false
                      ? 'This error will not resolve by retrying. Try a different approach or inform the user.'
                      : 'Correct the arguments per the error message and retry, or try a different approach.',
            },
          ],
        }
      : {}),
  }));
}
