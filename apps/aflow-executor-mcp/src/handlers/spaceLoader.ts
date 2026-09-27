import { eq } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  mcpServerBindings,
  mcpServerDefinitions,
  apiCredentials,
  buildCatalogGrantMap,
  type TenantIntegrationPolicy,
} from '@aflow/database';
import { McpServerBindingSchema, McpServerDefinitionSchema, TenantIdSchema } from '@aflow/schemas';
import type { McpServerBinding, McpServerDefinition } from '@aflow/schemas';
import {
  definitionStoreKey,
  getMcpSpaceStores,
  spaceScopeKey,
  type McpHandlerStores,
} from './types.js';

/**
 * Invalidate the cached slice for one `(tenantId, spaceId)`. Called by the
 * Pub/Sub subscriber when a write to that slice is detected.
 */
export function invalidateSpaceCache(
  stores: McpHandlerStores,
  tenantId: string,
  spaceId: string,
): void {
  const key = spaceScopeKey(tenantId, spaceId);
  stores.loadedAtMs.delete(key);
  stores.bySpace.delete(key);
}

export async function ensureTenantPolicyLoaded(
  stores: McpHandlerStores,
  opts: { db?: unknown; cacheTtlMs?: number },
  tenantId: string,
): Promise<TenantIntegrationPolicy> {
  return stores.tenantPolicyCache.load(opts.db, tenantId, {
    ...(opts.cacheTtlMs !== undefined ? { ttlMs: opts.cacheTtlMs } : {}),
  });
}

export async function ensureSpaceLoaded(
  stores: McpHandlerStores,
  opts: { db?: unknown; cacheTtlMs?: number },
  tenantId: string,
  spaceId: string,
): Promise<void> {
  const key = spaceScopeKey(tenantId, spaceId);
  const now = Date.now();
  const ttlMs = opts.cacheTtlMs ?? 2_000;
  const loadedAt = stores.loadedAtMs.get(key);
  if (loadedAt !== undefined && now - loadedAt < ttlMs) return;

  if (!opts.db) {
    stores.loadedAtMs.set(key, now);
    return;
  }

  const existing = stores.loadPromises.get(key);
  if (existing) return existing;

  const promise = loadSpaceData(stores, { db: opts.db }, tenantId, spaceId).finally(() => {
    stores.loadPromises.delete(key);
  });

  stores.loadPromises.set(key, promise);
  return promise;
}

async function loadSpaceData(
  stores: McpHandlerStores,
  opts: { db: unknown },
  tenantId: string,
  spaceId: string,
): Promise<void> {
  const tenantCtx = createTenantContext(TenantIdSchema.parse(tenantId));

  const { defRows, bindingRows, credRows } = await withTenantSchema(
    opts.db as Parameters<typeof withTenantSchema>[0],
    tenantCtx,
    async (tx) => {
      let defRows: unknown[] = [];
      let bindingRows: unknown[] = [];
      let credRows: unknown[] = [];
      try {
        defRows = await tx
          .select()
          .from(mcpServerDefinitions)
          .where(eq(mcpServerDefinitions.spaceId, spaceId));
      } catch {
        /* table may not exist on first migration */
      }
      try {
        bindingRows = await tx
          .select()
          .from(mcpServerBindings)
          .where(eq(mcpServerBindings.spaceId, spaceId));
      } catch {
        /* table may not exist on first migration */
      }
      try {
        credRows = await tx
          .select()
          .from(apiCredentials)
          .where(eq(apiCredentials.spaceId, spaceId));
      } catch {
        /* api_credentials should always exist but tolerate test envs */
      }
      return { defRows, bindingRows, credRows };
    },
  );

  const parsedDefs: McpServerDefinition[] = [];
  for (const row of (defRows ?? []) as Array<{ definitionJson?: unknown }>) {
    const raw = row.definitionJson as Record<string, unknown> | undefined;
    if (!raw) continue;
    const result = McpServerDefinitionSchema.safeParse(raw);
    if (result.success) {
      parsedDefs.push(result.data);
    } else {
      const serverId = (raw['serverId'] as string | undefined) ?? '<unknown>';
      const issues = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      console.warn(
        `[mcp spaceLoader] Skipping invalid MCP definition "${serverId}" in space ${spaceId}: ${issues}.`,
      );
    }
  }

  const parsedBindings: McpServerBinding[] = [];
  for (const row of (bindingRows ?? []) as Array<Record<string, unknown>>) {
    const rowSpaceId =
      typeof row['spaceId'] === 'string'
        ? row['spaceId']
        : typeof row['space_id'] === 'string'
          ? row['space_id']
          : spaceId;
    const rawScope = (row['scopeJson'] ?? {}) as Record<string, unknown>;
    const scope = { ...rawScope, spaceId: rowSpaceId };

    const raw: Record<string, unknown> = {
      bindingId: row['bindingId'],
      serverId: row['serverId'],
      name: row['name'],
      ...(row['description'] ? { description: row['description'] } : {}),
      scope,
      auth: row['authJson'],
      connectionPolicy: row['connectionPolicyJson'] ?? {},
      subscribeListChanged: row['subscribeListChanged'] === 1,
      samplingPolicy: (row['samplingPolicy'] as string | undefined) ?? 'off',
      ownerScope: row['ownerScope'] as string | undefined,
      clientScope: row['clientScope'] as string | undefined,
      ...(row['pinnedOrigin'] ? { pinnedOrigin: row['pinnedOrigin'] } : {}),
      ...(row['cachedTools'] ? { cachedTools: row['cachedTools'] } : {}),
      ...(row['cachedToolsAt']
        ? { cachedToolsAt: new Date(row['cachedToolsAt'] as string).toISOString() }
        : {}),
      ...(row['sessionMetadataJson'] ? { sessionMetadata: row['sessionMetadataJson'] } : {}),
      enabled: row['enabled'] === 1,
      ...(row['createdAt']
        ? { createdAt: new Date(row['createdAt'] as string).toISOString() }
        : {}),
      ...(row['updatedAt']
        ? { updatedAt: new Date(row['updatedAt'] as string).toISOString() }
        : {}),
    };
    const result = McpServerBindingSchema.safeParse(raw);
    if (result.success) {
      parsedBindings.push(result.data);
    } else {
      const bindingId = row['bindingId'] as string;
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      console.warn(
        `[mcp spaceLoader] Skipping invalid MCP binding "${bindingId}" in space ${spaceId}: ${issues}.`,
      );
    }
  }

  const credentialMap = new Map<string, string>();
  for (const row of (credRows ?? []) as Array<Record<string, unknown>>) {
    const key = (row['credentialKey'] ?? row['credential_key']) as string;
    const enc = (row['encryptedValue'] ?? row['encrypted_value']) as string;
    if (key && enc) credentialMap.set(key, enc);
  }

  const policy = await ensureTenantPolicyLoaded(stores, { db: opts.db }, tenantId);
  const grantMap =
    policy.mode === 'allowlist'
      ? await withTenantSchema(
          opts.db as Parameters<typeof withTenantSchema>[0],
          tenantCtx,
          async (tx) => buildCatalogGrantMap(tx, spaceId),
        )
      : new Map<string, string[]>();

  const slice = getMcpSpaceStores(stores, tenantId, spaceId);
  slice.definitionStore = new Map(
    parsedDefs.map((def) => [
      definitionStoreKey({ tenantId, spaceId, serverId: def.serverId }),
      def,
    ]),
  );
  slice.bindingStore = parsedBindings;
  slice.credentialStore = credentialMap;
  slice.catalogGrantStore = grantMap;
  stores.loadedAtMs.set(spaceScopeKey(tenantId, spaceId), Date.now());
}
