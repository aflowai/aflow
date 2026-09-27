/**
 * Reading a profile claim that may arrive namespaced.
 *
 * An access token minted for a custom API carries no standard OIDC profile
 * claims — the address, the name, the picture, and whether the directory
 * verified the address arrive only because the IdP was configured to inject
 * them, and a directory that allows that generally requires the claims it adds
 * to be namespaced (`https://aflow.ai/email`). A bare lookup finds none of
 * them, and for a boolean flag that is the dangerous shape: absent reads
 * exactly like the directory answering "no".
 */

/** The value of `name`, preferring the namespaced form the IdP actually sends. */
export function readClaim(claims: Record<string, unknown>, name: string): unknown {
  const namespaced = Object.entries(claims).find(([key]) => key.endsWith(`/${name}`));
  return namespaced ? namespaced[1] : claims[name];
}

/** A claim's string value, or undefined when it is absent, empty, or not a string. */
export function readStringClaim(claims: Record<string, unknown>, name: string): string | undefined {
  const value = readClaim(claims, name);
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * A claim's boolean value, or `undefined` when the token does not carry it.
 *
 * The three-way answer is the point: a caller that collapses absent into
 * `false` cannot tell a denial from a claim nobody configured, and only one of
 * those is safe to act on.
 */
export function readBooleanClaim(
  claims: Record<string, unknown>,
  name: string,
): boolean | undefined {
  const value = readClaim(claims, name);
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}
