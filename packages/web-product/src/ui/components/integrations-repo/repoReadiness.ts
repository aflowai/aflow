import type { ApiBindingSummary, IntegrationCredentialMeta } from '../../hooks/use-integrations.js';
import type { RepoBindingSummary } from '../../hooks/use-repo-bindings.js';

export type Readiness = 'ready' | 'needs_credential' | 'provisioning' | 'error';

/**
 * `owner/repo`, which is how anyone actually refers to a repository. The stored
 * coordinate is host-qualified, and in a narrow column the host eats the width
 * that identifies the repo — `github.com/acme/plat…` truncates to the one part
 * that says nothing.
 */
export function displayCoordinate(coordinate: string): string {
  return coordinate.startsWith('github.com/') ? coordinate.slice('github.com/'.length) : coordinate;
}

/**
 * Advisory client mirror of `resolveRepoBinding`'s git-credential resolution
 * (the lane resolver is the authority). Order mirrors the resolver: the
 * connection must exist AND be enabled FIRST — disabling a connection revokes
 * both planes even when a per-repo override is present — and only then is the
 * override preferred over the connection's bearer credential. It does NOT mirror
 * host-coherence (enforced at write-time + resolve-time), so a post-creation host
 * edit can read stale here.
 */
export function effectiveGitCredentialKey(
  binding: RepoBindingSummary,
  connectionsById: Map<string, ApiBindingSummary>,
): string | null {
  const conn = connectionsById.get(binding.connectionBindingId);
  if (!conn?.enabled) return null;
  const override = binding.credentialKey;
  if (override && override.length > 0) return override;
  if (conn.authType !== 'bearer') return null;
  const key = conn.auth['credentialKey'];
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/**
 * A binding is `ready` in the DB only after static validation, but the git
 * credential it resolves can be deleted (or its connection disabled) afterwards
 * — so readiness is recomputed against the live credential + connection state,
 * not just the stored status.
 */
export function getReadiness(
  binding: RepoBindingSummary,
  credentialsByKey: Map<string, IntegrationCredentialMeta>,
  connectionsById: Map<string, ApiBindingSummary>,
): Readiness {
  if (binding.status === 'error') return 'error';
  if (binding.status === 'provisioning') return 'provisioning';
  const key = effectiveGitCredentialKey(binding, connectionsById);
  if (!key || !credentialsByKey.get(key)?.hasValue) return 'needs_credential';
  return 'ready';
}
