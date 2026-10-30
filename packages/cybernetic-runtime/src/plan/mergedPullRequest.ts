import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { createTenantContext, decryptCredentialAsync, withTenantSchema } from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import { resolveConnectionForRepoCoordinate } from '../repoConnection.js';

/** Each close asks GitHub anew. Stored links and earlier answers confer no authority. */
export async function readMergedPullRequest(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  url: string,
): Promise<boolean> {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url);
  if (!match) return false;
  const [, owner, repo, number] = match;
  const bindingId = await resolveConnectionForRepoCoordinate(
    db,
    tenantId,
    spaceId,
    `${owner}/${repo}`,
  );
  const sealed = await withTenantSchema(
    db,
    createTenantContext(tenantId as TenantId),
    async (tx) => {
      const [row] = await tx.execute<{ encrypted: string }>(sql`
      SELECT c.encrypted_value AS encrypted
      FROM api_bindings b JOIN api_credentials c
        ON c.space_id = b.space_id AND c.credential_key = b.auth_json->>'credentialKey'
      WHERE b.space_id = ${spaceId}::uuid AND b.binding_id = ${bindingId}
        AND b.api_id = 'github' AND b.enabled = 1 AND b.auth_json->>'type' = 'bearer'
      LIMIT 1
    `);
      return row?.encrypted;
    },
  );
  if (!sealed) return false;
  const token = await decryptCredentialAsync(sealed);
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return false;
  const answer: unknown = await response.json();
  return (
    typeof answer === 'object' &&
    answer !== null &&
    'merged' in answer &&
    answer.merged === true &&
    'html_url' in answer &&
    answer.html_url === url.replace(/\/$/, '')
  );
}
