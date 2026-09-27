/**
 * Credential-preserving binding auth merge — the one compatibility rule the
 * connector and bundle update paths share. A binding's auth JSON carries
 * credential-slot NAMES the operator has bound values to; an update keeps it
 * verbatim when the new shape is compatible (same auth type, same slot names,
 * same OAuth issuer) so filled credentials survive, and placeholder-resets it
 * otherwise so the setup checklist reappears instead of calls failing with a
 * shape the resolver cannot read.
 */

export interface BindingAuthMergeResult {
  authJson: Record<string, unknown>;
  reset: boolean;
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((value) => setB.has(value));
}

export function mergeBindingAuth(opts: {
  existingAuthJson: Record<string, unknown>;
  placeholderAuthJson: Record<string, unknown>;
  extractCredentialKeys: (authJson: Record<string, unknown>) => string[];
}): BindingAuthMergeResult {
  const { existingAuthJson, placeholderAuthJson, extractCredentialKeys } = opts;
  const compatible =
    existingAuthJson['type'] === placeholderAuthJson['type'] &&
    existingAuthJson['issuerKey'] === placeholderAuthJson['issuerKey'] &&
    sameStringSet(
      extractCredentialKeys(existingAuthJson),
      extractCredentialKeys(placeholderAuthJson),
    );
  return compatible
    ? { authJson: existingAuthJson, reset: false }
    : { authJson: placeholderAuthJson, reset: true };
}
