/**
 * API handler types.
 */
import type {
  ApiBinding,
  ApiDefinition,
  ApiEndpoint,
  EgressPolicy,
  Simulation,
  SimulationSnapshot,
} from '@aflow/schemas';
import type { AflowError, SpaceWriteApprovalPolicy } from '@aflow/schemas';
import type { TenantPolicyCache } from '@aflow/database';

/**
 * Present only when the tenant runs in allowlist mode: the union of tenant
 * allowlist patterns and the resolved artifact's captured catalog grant.
 * Every contacted host (initial URL and each redirect hop) must match it —
 * intersected with, never replacing, the binding's own egress policy.
 */
export interface TenantHostGuard {
  permittedHosts: string[];
}

export interface ResolvedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  egressPolicy: EgressPolicy;
  apiId?: string;
  bindingId?: string;
  endpointId?: string;
  endpoint?: ApiEndpoint;
  tenantHostGuard?: TenantHostGuard;
  /**
   * Set only when the resolved binding declares simulated fulfillment. Its
   * presence is what proves a call cannot reach a real party — the executor
   * treats an absent value as live, so a path that forgets to thread it fails
   * closed rather than open.
   */
  simulation?: { simulationId: string; bindingId: string; apiId: string };
}

export class ApiExecutionError extends Error {
  readonly aflowError: AflowError;

  constructor(aflowError: AflowError) {
    super(aflowError.message);
    this.name = 'ApiExecutionError';
    this.aflowError = aflowError;
  }
}

export function spaceScopeKey(tenantId: string, spaceId: string): string {
  return `${tenantId}|${spaceId}`;
}

export function definitionStoreKey(parts: {
  tenantId: string;
  spaceId: string;
  apiId: string;
}): string {
  return `${parts.tenantId}|${parts.spaceId}|${parts.apiId}`;
}

export function simulationStoreKey(parts: {
  tenantId: string;
  spaceId: string;
  simulationId: string;
}): string {
  return `${parts.tenantId}|${parts.spaceId}|${parts.simulationId}`;
}

/**
 * The artifact a pinned run executes: the frozen simulation and the endpoint
 * set it was resolved against, indexed for lookup by endpoint id.
 */
export interface PinnedSimulation {
  snapshot: SimulationSnapshot;
  endpointsById: Map<string, ApiEndpoint>;
}

/** A simulation and the world a run starting now would pin itself to. */
export interface CachedSimulation {
  simulation: Simulation;
  /** Greatest baseline version, or 1 when no seed world has been authored yet. */
  baselineVersion: number;
  /**
   * The pinned baseline's own creation instant, which anchors the virtual
   * clock. Wall-clock time would make every run's world differ in the fields
   * agents filter and sort on.
   */
  baselineCreatedAtMs: number;
  loadedAtMs: number;
}

export interface ApiHandlerStores {
  /** Keyed by `${tenantId}|${spaceId}|${apiId}` — use `definitionStoreKey()`. */
  definitionStore: Map<string, ApiDefinition>;
  /**
   * Keyed by `${tenantId}|${spaceId}|${apiId}` — validation issues for a
   * definition row that exists but failed the model-schema parse. Lets the
   * call path say "exists but fails validation: <issues>" instead of the
   * misleading "not found".
   */
  invalidDefinitions: Map<string, string>;
  /** Keyed by `${tenantId}|${spaceId}` — bindings loaded for that space. */
  bindingStore: Map<string, ApiBinding[]>;
  /**
   * Keyed by `${tenantId}|${spaceId}` — inner Map is `credentialKey` →
   * encrypted blob for that space. Per-slice storage means
   * `getSpaceCredentials` is O(1) and allocates nothing per request, vs
   * scanning a flat global Map keyed by triple.
   */
  credentialStore: Map<string, Map<string, string>>;
  /** Keyed by `${tenantId}|${spaceId}` — last-loaded timestamp per slice. */
  loadedAtMs: Map<string, number>;
  /** Keyed by `${tenantId}|${spaceId}` — in-flight load promise per slice. */
  loadPromises: Map<string, Promise<void>>;
  /** Shared read-through cache for the tenant's integration policy. */
  tenantPolicyCache: TenantPolicyCache;
  /**
   * Keyed by `${tenantId}|${spaceId}` — the space's write-approval override
   * (Plan 253 P3), or null when the space has none (or the column is not yet
   * migrated). Loaded with the rest of the space slice; read at gate time so
   * the override is recomputed-at-read without a per-call DB hit.
   */
  spaceWritePolicyStore: Map<string, SpaceWriteApprovalPolicy | null>;
  /**
   * Keyed by `${tenantId}|${spaceId}` — inner Map is
   * `${artifactType}:${artifactKey}` → flattened captured-grant hosts.
   * Populated only when the tenant runs in allowlist mode.
   */
  catalogGrantStore: Map<string, Map<string, string[]>>;
  /**
   * Keyed by `${tenantId}|${spaceId}|${simulationId}` — use
   * `simulationStoreKey()`. Loaded on the first simulated call in a space
   * rather than with the space slice, so a space that runs no simulation pays
   * no query for one, and dropped by the same invalidation signal the
   * definitions and bindings take.
   */
  simulationStore: Map<string, CachedSimulation>;
  /** Keyed the same — in-flight load per simulation. */
  simulationLoadPromises: Map<string, Promise<CachedSimulation>>;
  /**
   * Keyed the same again — the last pinned artifact seen for that simulation,
   * tagged with the `snapshotRef` it came from. The ref is a content address,
   * so a hit can never be stale and needs no TTL, and a pinned run resolves
   * its snapshot with no round trip after the first call in the process. One
   * slot per simulation rather than one per ref, so the cache is bounded by
   * the space's artifacts the way every other store here is.
   */
  simulationSnapshotStore: Map<string, { ref: string; pinned: PinnedSimulation }>;
}
