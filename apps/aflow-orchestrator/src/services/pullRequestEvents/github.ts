/**
 * The conditional reads of the pull request event source (Plan 339 D2).
 *
 * Every read sends the ETag of the answer before it as `If-None-Match`, so a
 * pull request that has not changed answers `304 Not Modified`. GitHub's
 * documentation says a 304 to an authorised conditional request does not
 * count against the primary rate limit.
 *
 * The token is the space's own GitHub binding — the one Local Publish opens
 * pull requests with — read as the API executor reads it: the binding names a
 * credential key, and the space's credential under that key is decrypted. The
 * read goes to api.github.com only, and only where the binding allows GET to
 * that host.
 */
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  apiBindings,
  apiCredentials,
  createTenantContext,
  decryptCredentialAsync,
  withTenantSchema,
} from '@aflow/database';
import { AuthProfileSchema, type TenantId } from '@aflow/schemas';

export const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_API_HOST = 'api.github.com';
const GITHUB_API_ID = 'github';

export interface ConditionalAnswer {
  status: number;
  etag: string | null;
  body: unknown;
}

/** One conditional GET of a path under api.github.com, for a space. */
export type GitHubConditionalGet = (args: {
  tenantId: string;
  spaceId: string;
  /** Starts with `/`, e.g. `/repos/o/r/pulls/1`. */
  path: string;
  etag?: string;
  signal?: AbortSignal;
}) => Promise<ConditionalAnswer>;

export class GitHubReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubReadError';
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The token of the space's live, enabled GitHub binding, or an error saying what is missing. */
export async function readSpaceGitHubToken(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<string> {
  const { binding, credentials } = await withTenantSchema(
    db,
    createTenantContext(tenantId as TenantId),
    async (tx) => {
      const rows = await tx
        .select({
          authJson: apiBindings.authJson,
          egressPolicyJson: apiBindings.egressPolicyJson,
          enabled: apiBindings.enabled,
          fulfillmentMode: apiBindings.fulfillmentMode,
        })
        .from(apiBindings)
        .where(and(eq(apiBindings.spaceId, spaceId), eq(apiBindings.apiId, GITHUB_API_ID)));
      const live = rows.find((row) => row.enabled === 1 && row.fulfillmentMode === 'live');
      if (live === undefined) return { binding: undefined, credentials: [] };
      const auth = AuthProfileSchema.safeParse(live.authJson);
      const key = auth.success && auth.data.type === 'bearer' ? auth.data.credentialKey : undefined;
      const credentials =
        key === undefined
          ? []
          : await tx
              .select({ encryptedValue: apiCredentials.encryptedValue })
              .from(apiCredentials)
              .where(
                and(eq(apiCredentials.spaceId, spaceId), eq(apiCredentials.credentialKey, key)),
              );
      return { binding: live, credentials };
    },
  );
  if (binding === undefined) {
    throw new GitHubReadError(`Space ${spaceId} has no live, enabled GitHub binding.`);
  }
  const egress = binding.egressPolicyJson as { allowedHosts?: unknown; allowedMethods?: unknown };
  const hosts = Array.isArray(egress.allowedHosts) ? (egress.allowedHosts as unknown[]) : [];
  const methods = Array.isArray(egress.allowedMethods)
    ? (egress.allowedMethods as unknown[])
    : ['GET'];
  if ((hosts.length > 0 && !hosts.includes(GITHUB_API_HOST)) || !methods.includes('GET')) {
    throw new GitHubReadError(
      `The GitHub binding of space ${spaceId} does not allow GET to ${GITHUB_API_HOST}.`,
    );
  }
  const encrypted = credentials[0]?.encryptedValue;
  if (encrypted === undefined) {
    throw new GitHubReadError(`The GitHub binding of space ${spaceId} has no stored token.`);
  }
  return decryptCredentialAsync(encrypted);
}

const TOKEN_CACHE_MS = 60_000;

/** The production reader: the space's binding token, `fetch`, and a short token cache. */
export function createGitHubConditionalGet(deps: {
  db: PostgresJsDatabase;
  fetchImpl?: FetchLike;
  readToken?: (tenantId: string, spaceId: string) => Promise<string>;
  now?: () => number;
}): GitHubConditionalGet {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const readToken = deps.readToken ?? ((t, s) => readSpaceGitHubToken(deps.db, t, s));
  const now = deps.now ?? Date.now;
  const tokens = new Map<string, { token: string; expiresAt: number }>();

  return async ({ tenantId, spaceId, path, etag, signal }) => {
    const cacheKey = `${tenantId}:${spaceId}`;
    let cached = tokens.get(cacheKey);
    if (cached === undefined || cached.expiresAt <= now()) {
      cached = { token: await readToken(tenantId, spaceId), expiresAt: now() + TOKEN_CACHE_MS };
      tokens.set(cacheKey, cached);
    }
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cached.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (etag !== undefined && etag.length > 0) headers['If-None-Match'] = etag;
    const response = await fetchImpl(`${GITHUB_API_ORIGIN}${path}`, {
      method: 'GET',
      headers,
      redirect: 'error',
      ...(signal !== undefined ? { signal } : {}),
    });
    if (response.status === 401) tokens.delete(cacheKey);
    if (response.status === 304) {
      return { status: 304, etag: response.headers.get('etag') ?? etag ?? null, body: null };
    }
    if (!response.ok) {
      throw new GitHubReadError(`GitHub answered ${String(response.status)} to GET ${path}.`);
    }
    return {
      status: response.status,
      etag: response.headers.get('etag'),
      body: await response.json(),
    };
  };
}
