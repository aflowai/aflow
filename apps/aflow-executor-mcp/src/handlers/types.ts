import type {
  McpServerBinding,
  McpServerDefinition,
  McpCachedTool,
  McpSessionMetadata,
} from '@aflow/schemas';
import type { AflowError } from '@aflow/schemas';
import type { TenantPolicyCache } from '@aflow/database';

/**
 * Compose a stable `${tenantId}|${spaceId}` key for the per-slice maps.
 */
export function spaceScopeKey(tenantId: string, spaceId: string): string {
  return `${tenantId}|${spaceId}`;
}

export function definitionStoreKey(parts: {
  tenantId: string;
  spaceId: string;
  serverId: string;
}): string {
  return `${parts.tenantId}|${parts.spaceId}|${parts.serverId}`;
}

export class McpExecutionError extends Error {
  readonly aflowError: AflowError;

  constructor(aflowError: AflowError) {
    super(aflowError.message);
    this.name = 'McpExecutionError';
    this.aflowError = aflowError;
  }
}

/**
 * Per `(tenantId, spaceId)` slice of the in-memory MCP cache.
 */
export interface McpSpaceStores {
  /** Definitions keyed by `${tenantId}|${spaceId}|${serverId}`. */
  definitionStore: Map<string, McpServerDefinition>;
  /** Bindings loaded for this space. */
  bindingStore: McpServerBinding[];
  /** API credentials for this space — `credentialKey → encryptedValue`. */
  credentialStore: Map<string, string>;
  /**
   * `${artifactType}:${artifactKey}` → flattened captured-grant hosts.
   * Populated only when the tenant runs in allowlist mode.
   */
  catalogGrantStore: Map<string, string[]>;
}

export interface McpHandlerStores {
  /**
   * Per `(tenantId, spaceId)` cache slices, keyed by `spaceScopeKey()`. Each
   * entry is overwritten only by a fresh load for THAT slice.
   */
  bySpace: Map<string, McpSpaceStores>;
  /** Per-slice load-timestamp bookkeeping. */
  loadedAtMs: Map<string, number>;
  /** Per-slice in-flight load promise. */
  loadPromises: Map<string, Promise<void>>;
  /** Shared read-through cache for the tenant's integration policy. */
  tenantPolicyCache: TenantPolicyCache;
}

/**
 * Return the per-`(tenantId, spaceId)` slice, creating an empty one if
 * missing.
 */
export function getMcpSpaceStores(
  stores: McpHandlerStores,
  tenantId: string,
  spaceId: string,
): McpSpaceStores {
  const key = spaceScopeKey(tenantId, spaceId);
  let slice = stores.bySpace.get(key);
  if (!slice) {
    slice = {
      definitionStore: new Map(),
      bindingStore: [],
      credentialStore: new Map(),
      catalogGrantStore: new Map(),
    };
    stores.bySpace.set(key, slice);
  }
  return slice;
}

/**
 * Resolved binding cache write payload — used by `mcp.binding.test` and
 * `mcp.server.refresh_tools` to write back fresh tool lists, pinned origin,
 * and session metadata to a binding row.
 */
export interface BindingCacheUpdate {
  bindingId: string;
  serverId: string;
  cachedTools: McpCachedTool[];
  cachedToolsAt: string;
  pinnedOrigin: string;
  sessionMetadata: McpSessionMetadata;
}
