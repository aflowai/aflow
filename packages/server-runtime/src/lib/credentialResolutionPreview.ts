import { and, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createTenantContext, withTenantSchema, providerCredentials } from '@aflow/database';
import type { CredentialScope } from '@aflow/schemas';

type TenantIdArg = Parameters<typeof createTenantContext>[0];

export interface CredentialResolutionPreview {
  providerId: string;
  resolved: boolean;
  resolvedScope: CredentialScope | null;
  status: 'active' | 'error' | null;
  /**
   * When the resolved credential was last checked against the live provider.
   * `null` means it never has been — which a caller must not read as working:
   * a row is stored `active` before anything has tried the key in it.
   */
  verifiedAt: Date | null;
  lastErrorCode: string | null;
  availableScopes: Array<{ scope: CredentialScope; scopeId: string; status: 'active' | 'error' }>;
}

export function emptyResolutionPreview(providerId: string): CredentialResolutionPreview {
  return {
    providerId,
    resolved: false,
    resolvedScope: null,
    status: null,
    verifiedAt: null,
    lastErrorCode: null,
    availableScopes: [],
  };
}

/**
 * Batched user → space → tenant resolution preview. Metadata only — never
 * touches secrets. Shared by the credentials status route and the space
 * llm-readiness route so the preview can never diverge from itself.
 */
export async function previewCredentialResolution(
  db: PostgresJsDatabase,
  args: {
    tenantId: TenantIdArg;
    userId: string;
    spaceId: string;
    providerIds: readonly string[];
  },
): Promise<Map<string, CredentialResolutionPreview>> {
  const { tenantId, userId, spaceId, providerIds } = args;
  const previews = new Map<string, CredentialResolutionPreview>();
  for (const providerId of providerIds) {
    previews.set(providerId, emptyResolutionPreview(providerId));
  }
  if (providerIds.length === 0) return previews;

  const tenantContext = createTenantContext(tenantId);
  let typedRows: Array<typeof providerCredentials.$inferSelect>;
  try {
    const rows = await withTenantSchema(db, tenantContext, async (tx) => {
      return tx
        .select()
        .from(providerCredentials)
        .where(
          and(
            inArray(providerCredentials.providerId, [...providerIds]),
            inArray(providerCredentials.scopeId, [userId, spaceId, tenantId as string]),
          ),
        );
    });
    typedRows = rows as Array<typeof providerCredentials.$inferSelect>;
  } catch {
    // Table may not exist yet (migration not applied) — report nothing resolved.
    return previews;
  }

  const expectedScopeId: Record<CredentialScope, string> = {
    user: userId,
    space: spaceId,
    tenant: tenantId as string,
  };
  const visibleRows = typedRows.filter(
    (r) => expectedScopeId[r.scope as CredentialScope] === r.scopeId,
  );

  const scopeChain: readonly CredentialScope[] = ['user', 'space', 'tenant'];
  for (const providerId of providerIds) {
    const providerRows = visibleRows.filter((r) => r.providerId === providerId);
    const preview = previews.get(providerId)!;
    preview.availableScopes = providerRows.map((r) => ({
      scope: r.scope as CredentialScope,
      scopeId: r.scopeId,
      status: (r.status ?? 'active') as 'active' | 'error',
    }));
    for (const scope of scopeChain) {
      const match = providerRows.find((r) => r.scope === scope);
      if (match) {
        preview.resolved = true;
        preview.resolvedScope = scope;
        preview.status = (match.status ?? 'active') as 'active' | 'error';
        preview.verifiedAt = match.lastValidatedAt ?? null;
        preview.lastErrorCode = match.lastErrorCode ?? null;
        break;
      }
    }
  }
  return previews;
}
