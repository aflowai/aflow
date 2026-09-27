import type { Redis } from 'ioredis';
import { getSessionState } from '@aflow/redis';
import { DISCOVERY_SCOPE_VAR, type DiscoveryScope } from '../../helpers/agentTurn.js';
import type { InlineHandlerArgs } from './types.js';

/**
 * Resolve the active agent turn's `DiscoveryScope` from session runtime state.
 * Returns `undefined` only when no scope was written — in which case the
 * caller MUST treat the request as scope-less (wide-open for system tests
 * and unscoped agents). Production agent turns always write a scope.
 */
export async function loadDiscoveryScope(
  redis: Redis,
  context: InlineHandlerArgs['context'],
): Promise<DiscoveryScope | undefined> {
  const session = await getSessionState(redis, context.tenantId, context.runId);
  const entry = session?.runtimeState?.variables[DISCOVERY_SCOPE_VAR] as
    { ref?: { kind: string; value?: unknown } } | undefined;
  if (
    entry?.ref?.kind === 'inline' &&
    typeof entry.ref.value === 'object' &&
    entry.ref.value !== null
  ) {
    return entry.ref.value as DiscoveryScope;
  }
  return undefined;
}
