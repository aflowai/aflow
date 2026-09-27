import { eq } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  apiBindings,
  apiCredentials,
  apiDefinitions,
  spaces,
  buildCatalogGrantMap,
  type TenantIntegrationPolicy,
} from '@aflow/database';
import {
  ApiBindingSchema,
  ApiDefinitionSchema,
  SpaceWriteApprovalPolicySchema,
  TenantIdSchema,
} from '@aflow/schemas';
import type { ApiBinding, ApiDefinition } from '@aflow/schemas';
import { definitionStoreKey, spaceScopeKey, type ApiHandlerStores } from './types.js';

/**
 * Invalidate the cached slice for one `(tenantId, spaceId)`. Called by the
 * Pub/Sub subscriber when a write to that space's defs/bindings/creds is
 * detected; the next call in that space reloads from the database.
 */
export function invalidateSpaceCache(
  stores: ApiHandlerStores,
  tenantId: string,
  spaceId: string,
): void {
  const key = spaceScopeKey(tenantId, spaceId);
  stores.loadedAtMs.delete(key);

  // Drop any cached defs/bindings/credentials for this slice. Keep the rest
  // of the cache warm — other concurrent (tenantId, spaceId) pairs are
  // unaffected.
  for (const k of stores.definitionStore.keys()) {
    if (k.startsWith(`${key}|`)) stores.definitionStore.delete(k);
  }
  for (const k of stores.invalidDefinitions.keys()) {
    if (k.startsWith(`${key}|`)) stores.invalidDefinitions.delete(k);
  }
  for (const k of stores.simulationStore.keys()) {
    if (k.startsWith(`${key}|`)) stores.simulationStore.delete(k);
  }
  stores.bindingStore.delete(key);
  stores.credentialStore.delete(key);
  stores.catalogGrantStore.delete(key);
  stores.spaceWritePolicyStore.delete(key);
}

export async function ensureTenantPolicyLoaded(
  stores: ApiHandlerStores,
  opts: { db?: unknown; cacheTtlMs?: number },
  tenantId: string,
): Promise<TenantIntegrationPolicy> {
  return stores.tenantPolicyCache.load(opts.db, tenantId, {
    ...(opts.cacheTtlMs !== undefined ? { ttlMs: opts.cacheTtlMs } : {}),
  });
}

export async function ensureSpaceLoaded(
  stores: ApiHandlerStores,
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

/**
 * Return the cached credential Map for one `(tenantId, spaceId)` — a
 * `credentialKey → encryptedValue` lookup scoped to the caller's space.
 *
 * O(1), no allocation per call. The empty Map is returned when nothing has
 * been loaded yet (callers treat absence as "credential missing").
 */
const EMPTY_CREDENTIALS: ReadonlyMap<string, string> = new Map();
export function getSpaceCredentials(
  stores: ApiHandlerStores,
  tenantId: string,
  spaceId: string,
): ReadonlyMap<string, string> {
  return stores.credentialStore.get(spaceScopeKey(tenantId, spaceId)) ?? EMPTY_CREDENTIALS;
}

const ABSENT_RELATION_SQLSTATES = new Set(['42P01', '42703']);

/**
 * A tenant schema still short of a migration answers with SQLSTATE
 * `undefined_table` / `undefined_column`; every other failure — an outage, a
 * permission error, a dropped connection — must reach the caller, because the
 * alternative reading is a space that simply has no integrations. Drizzle wraps
 * the driver error, so the SQLSTATE sits on the cause chain rather than the
 * thrown object.
 *
 * All four reads share one transaction, so at most the last of them can be
 * absent and still commit: an earlier one poisons the transaction and the next
 * statement raises `in_failed_sql_transaction`, which propagates.
 */
function isAbsentRelationOrColumn(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (cursor !== null && cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    const code: unknown = (cursor as { code?: unknown }).code;
    if (typeof code === 'string' && ABSENT_RELATION_SQLSTATES.has(code)) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

async function loadSpaceData(
  stores: ApiHandlerStores,
  opts: { db: unknown },
  tenantId: string,
  spaceId: string,
): Promise<void> {
  const tenantCtx = createTenantContext(TenantIdSchema.parse(tenantId));

  const { defRows, bindingRows, credRows, writePolicyRaw } = await withTenantSchema(
    opts.db as Parameters<typeof withTenantSchema>[0],
    tenantCtx,
    async (tx) => {
      let defRows: unknown[] = [];
      let bindingRows: unknown[] = [];
      let credRows: unknown[] = [];
      let writePolicyRaw: unknown;
      try {
        defRows = await tx.select().from(apiDefinitions).where(eq(apiDefinitions.spaceId, spaceId));
      } catch (error) {
        if (!isAbsentRelationOrColumn(error)) throw error;
      }
      try {
        bindingRows = await tx.select().from(apiBindings).where(eq(apiBindings.spaceId, spaceId));
      } catch (error) {
        if (!isAbsentRelationOrColumn(error)) throw error;
      }
      try {
        credRows = await tx
          .select()
          .from(apiCredentials)
          .where(eq(apiCredentials.spaceId, spaceId));
      } catch (error) {
        if (!isAbsentRelationOrColumn(error)) throw error;
      }
      try {
        const rows = await tx
          .select({ writePolicy: spaces.writePolicy })
          .from(spaces)
          .where(eq(spaces.id, spaceId))
          .limit(1);
        writePolicyRaw = rows[0]?.writePolicy;
      } catch (error) {
        if (!isAbsentRelationOrColumn(error)) throw error;
      }
      return { defRows, bindingRows, credRows, writePolicyRaw };
    },
  );

  const parsedWritePolicy =
    writePolicyRaw != null ? SpaceWriteApprovalPolicySchema.safeParse(writePolicyRaw) : null;
  stores.spaceWritePolicyStore.set(
    spaceScopeKey(tenantId, spaceId),
    parsedWritePolicy?.success ? parsedWritePolicy.data : null,
  );

  // Per-row safeParse + skip-with-warn. Without this, one malformed row
  // (e.g. left behind from an earlier schema iteration) throws and takes
  // the space's whole load down — every subsequent api.http.call for ANY
  // API in this space fails with the same Zod error. The issues are kept in
  // `invalidDefinitions` so the call path can distinguish "exists but fails
  // validation" from a genuinely missing definition.
  const parsedDefs: ApiDefinition[] = [];
  const invalidDefs = new Map<string, string>();
  for (const row of (defRows ?? []) as Array<{ definitionJson?: unknown }>) {
    const raw = row.definitionJson as Record<string, unknown> | undefined;
    if (!raw) continue;
    const result = ApiDefinitionSchema.safeParse(raw);
    if (result.success) {
      parsedDefs.push(result.data);
    } else {
      const apiId = (raw['apiId'] as string | undefined) ?? '<unknown>';
      const issues = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      invalidDefs.set(apiId, issues);
      console.warn(
        `[spaceLoader] Skipping invalid API definition "${apiId}" in space ${spaceId}: ${issues}. ` +
          'Re-bind via the bind-capability skill or remove the row from api_definitions to clean up.',
      );
    }
  }

  const parsedBindings: ApiBinding[] = [];
  for (const row of (bindingRows ?? []) as Array<Record<string, unknown>>) {
    const rawScope = (row['scopeJson'] as Record<string, unknown> | null) ?? {};
    const scope = { ...rawScope, tenantId, spaceId };

    const raw = {
      bindingId: row['bindingId'],
      apiId: row['apiId'],
      name: row['name'],
      ...(row['description'] ? { description: row['description'] } : {}),
      scope,
      auth: row['authJson'],
      egressPolicy: row['egressPolicyJson'],
      ...(row['variableValuesJson'] ? { variableValues: row['variableValuesJson'] } : {}),
      fulfillment:
        row['fulfillmentMode'] === 'simulated' && typeof row['simulationId'] === 'string'
          ? { mode: 'simulated', simulationId: row['simulationId'] }
          : { mode: 'live' },
      enabled: row['enabled'] === 1,
      ...(row['createdAt']
        ? { createdAt: new Date(row['createdAt'] as string).toISOString() }
        : {}),
      ...(row['updatedAt']
        ? { updatedAt: new Date(row['updatedAt'] as string).toISOString() }
        : {}),
    };
    const result = ApiBindingSchema.safeParse(raw);
    if (result.success) {
      parsedBindings.push(result.data);
    } else {
      const bindingId = row['bindingId'] as string;
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      console.warn(
        `[spaceLoader] Skipping invalid binding "${bindingId}" in space ${spaceId}: ${issues}. ` +
          'Edit the connection in Settings → Integrations to fix it.',
      );
    }
  }

  const sliceCreds = new Map<string, string>();
  for (const row of (credRows ?? []) as Array<Record<string, unknown>>) {
    const credKey = (row['credentialKey'] ?? row['credential_key']) as string;
    const enc = (row['encryptedValue'] ?? row['encrypted_value']) as string;
    if (credKey && enc) sliceCreds.set(credKey, enc);
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

  // Replace the slice for this space; preserve everything else.
  invalidateSpaceCache(stores, tenantId, spaceId);
  for (const def of parsedDefs) {
    stores.definitionStore.set(definitionStoreKey({ tenantId, spaceId, apiId: def.apiId }), def);
  }
  for (const [apiId, issues] of invalidDefs) {
    stores.invalidDefinitions.set(definitionStoreKey({ tenantId, spaceId, apiId }), issues);
  }
  const sliceKey = spaceScopeKey(tenantId, spaceId);
  stores.bindingStore.set(sliceKey, parsedBindings);
  stores.credentialStore.set(sliceKey, sliceCreds);
  stores.catalogGrantStore.set(sliceKey, grantMap);
  stores.loadedAtMs.set(sliceKey, Date.now());
}
