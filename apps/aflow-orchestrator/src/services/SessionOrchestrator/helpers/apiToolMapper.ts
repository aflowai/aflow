import type { ApiEndpoint, AgentToolSpec } from '@aflow/schemas';
import { buildVirtualToolSpec, deriveEndpointToolSchema } from '@aflow/schemas';

// ============================================================================
// 104n: Binding-aware, endpoint-filtered tool mapping
// ============================================================================

/**
 * Grant context for mapping a specific API binding's endpoints to tools.
 * Built from `TaskCapabilityGrant.apis[]` in the delegation path.
 */
export interface ApiGrantContext {
  capabilityId: string;
  bindingId: string;
  apiId: string;
  /** Specific endpoint IDs to promote. Must be non-empty unless `allEndpoints` is true. */
  grantedEndpointIds: Set<string>;
  /** Explicit broad grant flag. When false, `grantedEndpointIds` must be non-empty. */
  allEndpoints: boolean;
  /** True when multiple bindings exist for the same apiId — uses capabilityId in callName. */
  useQualifiedName: boolean;
}

/**
 * Map granted API endpoints to binding-aware AgentToolSpec virtual tools (104n).
 *
 * Unlike `mapApiEndpointToToolSpec` (`@aflow/schemas`), this function:
 * - Filters endpoints to only those in the grant
 * - Uses `bindingId` in the toolId (collision-free across multiple bindings)
 * - Uses `capabilityId` in callName when `useQualifiedName` is true
 * - Carries `bindingId` + `capabilityId` in apiMeta for downstream lowering
 */
export function mapGrantedEndpointsToToolSpecs(
  apiName: string,
  allEndpoints: ApiEndpoint[],
  grant: ApiGrantContext,
): AgentToolSpec[] {
  const specs: AgentToolSpec[] = [];

  // Reject malformed grants: no endpoints and not explicitly broad
  if (!grant.allEndpoints && grant.grantedEndpointIds.size === 0) {
    return [];
  }

  for (const endpoint of allEndpoints) {
    // Filter: skip endpoints not in the grant (unless explicitly broad)
    if (!grant.allEndpoints && !grant.grantedEndpointIds.has(endpoint.endpointId)) {
      continue;
    }

    // Binding-scoped toolId — avoids collision when multiple bindings for same apiId
    const toolId = `api:${grant.bindingId}/${endpoint.endpointId}`;
    // callName: qualified when multi-binding, plain when single
    const namePrefix = grant.useQualifiedName ? grant.capabilityId : grant.apiId;
    const callName = `${namePrefix}.${endpoint.endpointId}`;

    specs.push(
      buildVirtualToolSpec({
        operationId: toolId,
        stepType: 'api',
        name: endpoint.name || `${namePrefix}.${endpoint.endpointId}`,
        description:
          endpoint.description || `${endpoint.method} ${endpoint.pathTemplate} (${apiName})`,
        inputSchema: deriveEndpointToolSchema(endpoint),
        source: 'api',
        lowering: 'api_call',
        callName,
        apiMeta: {
          apiId: grant.apiId,
          endpointId: endpoint.endpointId,
          bindingId: grant.bindingId,
          capabilityId: grant.capabilityId,
        },
      }),
    );
  }

  return specs;
}
