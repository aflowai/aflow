/**
 * Per-user "Connected accounts" surface (Plan 185 §11).
 *
 * A connection is one `oauth_tokens` row the signed-in user owns
 * (`owner_scope='user'`, `owner_id=userId`). Connect-once (§3.3) means a single
 * row per (integration_kind, resource_key) regardless of how many bindings or
 * spaces replay it — so the display name + requested scopes are derived from any
 * matching binding in the tenant, joined to the curated issuer registry (O4).
 *
 * Tokens are NEVER returned — only presence, granted scopes, expiry, and a
 * connected/expired status.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createTenantContext,
  withTenantSchema,
  oauthTokens,
  apiBindings,
  mcpServerBindings,
  type OauthTokenRow,
} from '@aflow/database';
import {
  OAuthConsentOwnerScopeSchema,
  getOAuthIssuer,
  type OAuthBindingConnection,
  type OAuthConnection,
  type OAuthConsentIntegrationKind,
  type TenantId,
} from '@aflow/schemas';
import { resolveOAuthOwner, type OAuthOwnerContext } from '@aflow/oauth';

type ConnectionTokenRow = Pick<
  OauthTokenRow,
  'integrationKind' | 'resourceKey' | 'scopesJson' | 'expiresAt'
> & { hasRefreshToken: boolean };

/** A token row enriched with the binding-derived label + granted scopes. */
export function toOAuthConnection(
  row: ConnectionTokenRow,
  displayName: string,
  now: Date,
): OAuthConnection {
  return {
    integrationKind: row.integrationKind as OAuthConsentIntegrationKind,
    resourceKey: row.resourceKey,
    displayName,
    scopes: row.scopesJson,
    expiresAt: row.expiresAt.toISOString(),
    status: connectionStatus(row, now),
  };
}

/**
 * An access token living an hour is the provider's design, not a broken
 * connection: with a refresh token the next call renews it silently, so the
 * connection is healthy. 'expired' means truly dead — no refresh token and the
 * access token past its end.
 */
function connectionStatus(
  row: { hasRefreshToken: boolean; expiresAt: Date },
  now: Date,
): OAuthConnection['status'] {
  return row.hasRefreshToken || row.expiresAt.getTime() > now.getTime() ? 'connected' : 'expired';
}

/** An API binding as the list route reads it — only what names its token. */
export interface BindingTokenTarget {
  bindingId: string;
  apiId: string;
  authJson: Record<string, unknown> | null;
}

/**
 * The OAuth token each `oauth2_authorization_code` binding resolves, keyed by
 * binding id: null where no token exists yet. The owner is resolved exactly as
 * consent and the executor resolve it, so a space-owned token shows on every
 * member's card and a user-owned one only on its owner's. Bindings of other
 * auth types are absent from the map.
 */
export async function listBindingOAuthConnections(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  bindings: readonly BindingTokenTarget[],
  owner: OAuthOwnerContext,
  now: Date = new Date(),
): Promise<Map<string, OAuthBindingConnection | null>> {
  const result = new Map<string, OAuthBindingConnection | null>();
  const wanted: Array<{ bindingId: string; apiId: string; ownerScope: string; ownerId: string }> =
    [];
  for (const binding of bindings) {
    if (binding.authJson?.['type'] !== 'oauth2_authorization_code') continue;
    result.set(binding.bindingId, null);
    const ownerScope = OAuthConsentOwnerScopeSchema.safeParse(binding.authJson['ownerScope']);
    if (!ownerScope.success) continue;
    const resolved = resolveOAuthOwner(ownerScope.data, owner);
    if (!('ownerId' in resolved)) continue;
    wanted.push({
      bindingId: binding.bindingId,
      apiId: binding.apiId,
      ownerScope: ownerScope.data,
      ownerId: resolved.ownerId,
    });
  }
  if (wanted.length === 0) return result;

  const owners = new Map(wanted.map((w) => [`${w.ownerScope}:${w.ownerId}`, w]));
  const ownerMatches = [...owners.values()].map((w) =>
    and(eq(oauthTokens.ownerScope, w.ownerScope), eq(oauthTokens.ownerId, w.ownerId)),
  );

  const rows = (await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
    tx
      .select({
        resourceKey: oauthTokens.resourceKey,
        ownerScope: oauthTokens.ownerScope,
        ownerId: oauthTokens.ownerId,
        scopesJson: oauthTokens.scopesJson,
        accountIdentity: oauthTokens.accountIdentity,
        connectedAt: oauthTokens.connectedAt,
        expiresAt: oauthTokens.expiresAt,
        hasRefreshToken: sql<boolean>`(${oauthTokens.refreshTokenEnc} IS NOT NULL)`,
      })
      .from(oauthTokens)
      .where(
        and(
          eq(oauthTokens.integrationKind, 'api'),
          inArray(oauthTokens.resourceKey, [...new Set(wanted.map((w) => w.apiId))]),
          or(...ownerMatches),
        ),
      ),
  )) as BindingTokenRow[];

  for (const w of wanted) {
    const row = rows.find(
      (r) => r.resourceKey === w.apiId && r.ownerScope === w.ownerScope && r.ownerId === w.ownerId,
    );
    if (row) result.set(w.bindingId, toBindingConnection(row, now));
  }
  return result;
}

type BindingTokenRow = Pick<
  OauthTokenRow,
  | 'resourceKey'
  | 'ownerScope'
  | 'ownerId'
  | 'scopesJson'
  | 'accountIdentity'
  | 'connectedAt'
  | 'expiresAt'
> & { hasRefreshToken: boolean };

export function toBindingConnection(row: BindingTokenRow, now: Date): OAuthBindingConnection {
  return {
    account: row.accountIdentity ?? null,
    connectedAt: row.connectedAt ? row.connectedAt.toISOString() : null,
    scopes: row.scopesJson,
    status: connectionStatus(row, now),
  };
}

/**
 * Resolve a human label for a resource: an API binding's auth_json issuerKey →
 * curated issuer registry, falling back to the binding's stored name, then the
 * raw resource key. MCP bindings discover the issuer via PRM and carry no
 * issuerKey, so they fall back to the binding name.
 */
export function deriveConnectionDisplayName(
  bindingName: string | undefined,
  issuerKey: string | undefined,
  resourceKey: string,
): string {
  if (issuerKey) {
    const issuer = getOAuthIssuer(issuerKey);
    if (issuer) return issuer.displayName;
  }
  if (bindingName && bindingName.trim().length > 0) return bindingName;
  return resourceKey;
}

/**
 * List the signed-in user's OAuth connections for a tenant. Reads only
 * `owner_scope='user'` token rows owned by `userId`, enriches each with a label
 * (issuer registry first, binding name fallback), and reports status without
 * exposing any token material.
 */
export async function listUserOAuthConnections(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  userId: string,
  now: Date = new Date(),
): Promise<OAuthConnection[]> {
  const tenantContext = createTenantContext(tenantId);

  return withTenantSchema(db, tenantContext, async (tx) => {
    const owned = (await tx
      .select({
        integrationKind: oauthTokens.integrationKind,
        resourceKey: oauthTokens.resourceKey,
        scopesJson: oauthTokens.scopesJson,
        expiresAt: oauthTokens.expiresAt,
        hasRefreshToken: sql<boolean>`(${oauthTokens.refreshTokenEnc} IS NOT NULL)`,
      })
      .from(oauthTokens)
      .where(
        and(eq(oauthTokens.ownerScope, 'user'), eq(oauthTokens.ownerId, userId)),
      )) as ConnectionTokenRow[];

    if (owned.length === 0) return [];

    const apiResourceKeys = new Set(
      owned.filter((r) => r.integrationKind === 'api').map((r) => r.resourceKey),
    );
    const mcpResourceKeys = new Set(
      owned.filter((r) => r.integrationKind === 'mcp').map((r) => r.resourceKey),
    );

    // resource_key → { name, issuerKey } from any binding in the tenant. The
    // connect-once token outlives any single binding, so the first match wins.
    const apiMeta = new Map<string, { name: string; issuerKey?: string }>();
    if (apiResourceKeys.size > 0) {
      const apiRows = (await tx
        .select({
          apiId: apiBindings.apiId,
          name: apiBindings.name,
          authJson: apiBindings.authJson,
        })
        .from(apiBindings)) as Array<{
        apiId: string;
        name: string;
        authJson: Record<string, unknown> | null;
      }>;
      for (const r of apiRows) {
        if (!apiResourceKeys.has(r.apiId) || apiMeta.has(r.apiId)) continue;
        const issuerKey =
          typeof r.authJson?.['issuerKey'] === 'string' ? r.authJson['issuerKey'] : undefined;
        apiMeta.set(r.apiId, { name: r.name, ...(issuerKey ? { issuerKey } : {}) });
      }
    }

    const mcpMeta = new Map<string, { name: string }>();
    if (mcpResourceKeys.size > 0) {
      const mcpRows = (await tx
        .select({ serverId: mcpServerBindings.serverId, name: mcpServerBindings.name })
        .from(mcpServerBindings)) as Array<{ serverId: string; name: string }>;
      for (const r of mcpRows) {
        if (!mcpResourceKeys.has(r.serverId) || mcpMeta.has(r.serverId)) continue;
        mcpMeta.set(r.serverId, { name: r.name });
      }
    }

    return owned.map((r) => {
      if (r.integrationKind === 'api') {
        const meta = apiMeta.get(r.resourceKey);
        return toOAuthConnection(
          r,
          deriveConnectionDisplayName(meta?.name, meta?.issuerKey, r.resourceKey),
          now,
        );
      }
      const meta = mcpMeta.get(r.resourceKey);
      return toOAuthConnection(
        r,
        deriveConnectionDisplayName(meta?.name, undefined, r.resourceKey),
        now,
      );
    });
  });
}

/**
 * Delete the signed-in user's token row for a single resource. The next call
 * resolves no user token and re-pauses for consent (§9.3). Returns the number of
 * rows removed (0 when the user had no connection for that resource).
 */
export async function disconnectUserOAuthConnection(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  userId: string,
  integrationKind: OAuthConsentIntegrationKind,
  resourceKey: string,
): Promise<number> {
  const tenantContext = createTenantContext(tenantId);
  const deleted = await withTenantSchema(db, tenantContext, async (tx) => {
    return tx
      .delete(oauthTokens)
      .where(
        and(
          eq(oauthTokens.integrationKind, integrationKind),
          eq(oauthTokens.resourceKey, resourceKey),
          eq(oauthTokens.ownerScope, 'user'),
          eq(oauthTokens.ownerId, userId),
        ),
      )
      .returning({ resourceKey: oauthTokens.resourceKey });
  });
  return deleted.length;
}
