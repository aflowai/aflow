import type { SessionEvent, UserFacingError } from '../../lib/types.js';

// =============================================================================
// Event field accessor — server wraps metadata/patch inside `data`, but types
// define them at top level. This helper checks both locations.
// =============================================================================

export function ev(event: SessionEvent) {
  const d = event.data;
  const rawUe = event.metadata?.['userError'] ?? d?.['userError'];
  return {
    stepName: (event.metadata?.['stepName'] ?? d?.['stepName']) as string | undefined,
    operationId: (event.metadata?.['operationId'] ?? d?.['operationId']) as string | undefined,
    stepDetail: (event.metadata?.['stepDetail'] ?? d?.['stepDetail']) as string | undefined,
    inputRef: (event.metadata?.['inputRef'] ?? d?.['inputRef']) as string | undefined,
    errorMessage: (event.metadata?.['errorMessage'] ?? d?.['errorMessage']) as string | undefined,
    willRetry: (d?.['willRetry'] ?? event.metadata?.['willRetry']) as boolean | undefined,
    stepType: d?.stepType,
    stepId: d?.stepId,
    outputRef: (d?.payloadRef ?? d?.['outputRef']) as string | undefined,
    errorRef: d?.errorRef,
    userError: (rawUe && typeof rawUe === 'object' && 'title' in rawUe ? rawUe : undefined) as
      UserFacingError | undefined,
    runtimeStatePatch: d?.runtimeStatePatch as
      | {
          version: number;
          changed: Array<{ key: string; value?: unknown }>;
        }
      | undefined,
    agentAction: (event.metadata?.['agentAction'] ?? d?.['agentAction']) as string | undefined,
    invokedTools: (event.metadata?.['invokedTools'] ?? d?.['invokedTools']) as
      Array<{ stepId: string; name: string; operation: string }> | undefined,
    responseOptions: (event.metadata?.['responseOptions'] ?? d?.['responseOptions']) as
      { type: string; options: Array<{ value: string; label?: string }> } | undefined,
    pauseType: (event.metadata?.['pauseType'] ?? d?.['pauseType']) as string | undefined,
    dispatchWrapper: (event.metadata?.['dispatchWrapper'] ?? d?.['dispatchWrapper']) as
      boolean | undefined,
  };
}
