import {
  DEFAULT_PRIVATE_NETWORK_POLICY,
  validateCredentialedUrl,
  type PrivateNetworkPolicy,
} from '@aflow/network-safety';
import type { AsMetadata } from './asMetadata.js';

/**
 * Which account a consent connected, as the provider reported it at the token
 * exchange. Read once, inside consent completion, and stored on the token row.
 *
 * Only a reported fact counts: the `email` claim of the id token, then the
 * `email` the provider's OIDC userinfo endpoint returns. A provider that
 * reports neither yields `null`, and the page then says "Connected" with no
 * account. Nothing is inferred from scopes, client ids or binding names.
 */
export interface ReadAccountIdentityParams {
  /** The raw token endpoint response. */
  token: { access_token: string; token_type?: string; id_token?: unknown };
  asMetadata: AsMetadata;
  /** The client_id the token was minted for — an id token must name it in `aud`. */
  clientId: string;
  privateNetwork?: PrivateNetworkPolicy;
  fetchImpl?: typeof fetch;
}

export async function readAccountIdentity(
  params: ReadAccountIdentityParams,
): Promise<string | null> {
  const fromIdToken = emailFromIdToken(params.token.id_token, params.clientId);
  if (fromIdToken) return fromIdToken;

  const userinfoEndpoint = params.asMetadata['userinfo_endpoint'];
  if (typeof userinfoEndpoint !== 'string' || userinfoEndpoint.length === 0) return null;
  try {
    return await emailFromUserinfo(userinfoEndpoint, params);
  } catch (err) {
    // Consent has already succeeded. An identity read that fails leaves the
    // account unknown rather than failing the connection.
    console.warn(
      `[oauth] userinfo read failed at ${userinfoEndpoint}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * The id token arrives in the token endpoint's own TLS response, which OIDC
 * Core §3.1.3.7 accepts in place of a signature check. Its audience must still
 * name this client, so a token minted for another client is never read as ours.
 */
export function emailFromIdToken(idToken: unknown, clientId: string): string | null {
  if (typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (!isRecord(claims)) return null;
  const aud = claims['aud'];
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(clientId)) return null;
  return emailClaim(claims);
}

async function emailFromUserinfo(
  endpoint: string,
  params: ReadAccountIdentityParams,
): Promise<string | null> {
  const validated = await validateCredentialedUrl(
    endpoint,
    params.privateNetwork ?? DEFAULT_PRIVATE_NETWORK_POLICY,
  );
  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(validated.url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${params.token.access_token}`,
      Accept: 'application/json',
    },
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`userinfo answered ${String(response.status)}`);
  const body: unknown = await response.json();
  return isRecord(body) ? emailClaim(body) : null;
}

function emailClaim(claims: Record<string, unknown>): string | null {
  const email = claims['email'];
  return typeof email === 'string' && email.trim().length > 0 ? email.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
