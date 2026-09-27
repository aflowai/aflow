import type { CredentialScope } from '@aflow/schemas';

export interface CredentialContext {
  tenantId: string;
  credentialOwnerId: string;
  spaceId: string;
}

export interface ResolvedProvider {
  /** Decrypted secret values keyed by fieldId */
  secrets: Record<string, string>;
  /** Non-secret config values keyed by fieldId */
  config: Record<string, string>;
  /** Which scope this bundle resolved from */
  scope: CredentialScope;
  /** The scope_id (for audit/cost tracking) */
  scopeId: string;
  /** The credential record ID */
  credentialId: string;
  /** When the credential was last updated (for rotation-safe caching) */
  updatedAt: string;
}

/**
 * Load function signature — abstracts DB access so the resolver
 * doesn't depend on a specific DB client. The server or executor
 * provides the implementation.
 */
export type CredentialLoader = (tenantId: string, providerId: string) => Promise<CredentialRow[]>;

/** Minimal row shape the resolver needs from the DB. */
export interface CredentialRow {
  id: string;
  providerId: string;
  scope: string;
  scopeId: string;
  encryptedSecrets: string;
  configJson: Record<string, unknown>;
  status: string;
  updatedAt: string;
}
