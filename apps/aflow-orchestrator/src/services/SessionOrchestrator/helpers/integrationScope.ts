import type { IntegrationScopeFilter } from './integrationReader.js';
import type { DiscoveryScope } from './agentTurn.js';

export function buildIntegrationScopeFilter(
  scope: DiscoveryScope | undefined,
  includeApis: boolean,
  includeMcp: boolean,
): IntegrationScopeFilter {
  const requestedKinds: Array<'api' | 'mcp'> = [];
  if (includeApis) requestedKinds.push('api');
  if (includeMcp) requestedKinds.push('mcp');

  // Caller wants no integrations — return a filter that yields nothing.
  if (requestedKinds.length === 0) return { allowed: [] };

  if (scope?.integrations) {
    const integ = scope.integrations;
    if (integ.mode === 'none') return { allowed: [] };

    const scopeSourceKinds = integ.sourceKinds ?? ['api', 'mcp'];
    const effective = requestedKinds.filter((sk) => scopeSourceKinds.includes(sk));
    // Empty intersection → no results. Omitting `sourceKinds` would silently
    // widen the read model; explicitly empty the allowlist instead.
    if (effective.length === 0) return { allowed: [] };

    const filter: IntegrationScopeFilter = { sourceKinds: effective };
    if (integ.mode === 'allowlist') {
      const allowed = (integ.allowed ?? []).filter((a) => effective.includes(a.sourceKind));
      filter.allowed = allowed;
    }
    return filter;
  }

  // Legacy fallback (no unified integrations scope set). The split fields
  if (scope?.allowedStepTypes && scope.allowedStepTypes.length > 0) {
    const allowedSet = new Set(scope.allowedStepTypes);
    const intersected = requestedKinds.filter((sk) => allowedSet.has(sk));
    if (intersected.length === 0) return { allowed: [] };
    const filter: IntegrationScopeFilter = { sourceKinds: intersected };
    const scopeRecord = scope as DiscoveryScope & { allowedApiIds?: string[] };
    const allowedApiIds = scopeRecord.allowedApiIds;
    const allowedMcpServerIds = scope.allowedMcpServerIds;
    if (allowedApiIds || allowedMcpServerIds) {
      const allowed: NonNullable<IntegrationScopeFilter['allowed']> = [];
      if (allowedApiIds && intersected.includes('api')) {
        for (const id of allowedApiIds) allowed.push({ sourceKind: 'api', integrationId: id });
      }
      if (allowedMcpServerIds && intersected.includes('mcp')) {
        for (const id of allowedMcpServerIds)
          allowed.push({ sourceKind: 'mcp', integrationId: id });
      }
      if (allowed.length > 0) filter.allowed = allowed;
    }
    return filter;
  }

  // Scope exists but grants no integration surface: no integrations config,
  // no integration-bearing step types. This includes the op-level-only scope
  // a task's promotable grant derives (allowedOperationIds, empty step
  // types) — promotable platform ops never open integration discovery.
  // Fail closed unless legacy per-source allowlists are present.
  const scopeRecord = scope as (DiscoveryScope & { allowedApiIds?: string[] }) | undefined;
  const allowedApiIds = scopeRecord?.allowedApiIds;
  const allowedMcpServerIds = scope?.allowedMcpServerIds;
  if (scope && (allowedApiIds || allowedMcpServerIds)) {
    const filter: IntegrationScopeFilter = { sourceKinds: requestedKinds };
    const allowed: NonNullable<IntegrationScopeFilter['allowed']> = [];
    if (allowedApiIds && includeApis) {
      for (const id of allowedApiIds) allowed.push({ sourceKind: 'api', integrationId: id });
    }
    if (allowedMcpServerIds && includeMcp) {
      for (const id of allowedMcpServerIds) allowed.push({ sourceKind: 'mcp', integrationId: id });
    }
    if (allowed.length > 0) filter.allowed = allowed;
    return filter;
  }

  // No scope at all — discovery is not enabled for this agent. Fail closed:
  // an absent scope must never read as "everything is discoverable".
  return { allowed: [] };
}
