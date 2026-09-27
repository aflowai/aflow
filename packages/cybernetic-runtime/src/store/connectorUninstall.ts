/**
 * Connector teardown cores — the one authority for disabling and deleting an
 * integration's artifacts, shared by the store uninstall execution and the
 * manual /integrations delete routes. Deleting a definition tears down the
 * space-owned OAuth tokens/state for the integration (user/tenant tokens
 * survive — the provider may live in other spaces), cascades its bindings,
 * and then removes credential rows no surviving binding references.
 */
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { extractCredentialKeys } from '../stagedChange/apiWriteHelpers.js';

export function collectCredentialKeys(authJsons: ReadonlyArray<Record<string, unknown>>): string[] {
  const set = new Set<string>();
  for (const auth of authJsons) {
    for (const key of extractCredentialKeys(auth)) set.add(key);
  }
  return [...set];
}

export async function findUnreferencedCredentialKeys(
  tx: Pick<PostgresJsDatabase, 'execute'>,
  spaceId: string,
  candidateKeys: string[],
): Promise<string[]> {
  if (candidateKeys.length === 0) return [];
  const apiRows = (await tx.execute(sql`
    SELECT auth_json FROM api_bindings WHERE space_id = ${spaceId}::uuid
  `)) as unknown as Array<{ auth_json: Record<string, unknown> | null }>;
  const mcpRows = (await tx.execute(sql`
    SELECT auth_json FROM mcp_server_bindings WHERE space_id = ${spaceId}::uuid
  `)) as unknown as Array<{ auth_json: Record<string, unknown> | null }>;
  const referenced = new Set(
    collectCredentialKeys([
      ...apiRows.map((row) => row.auth_json ?? {}),
      ...mcpRows.map((row) => row.auth_json ?? {}),
    ]),
  );
  return candidateKeys.filter((key) => !referenced.has(key));
}

async function deleteUnreferencedCredentials(
  tx: PostgresJsDatabase,
  spaceId: string,
  candidateKeys: string[],
): Promise<void> {
  const toDelete = await findUnreferencedCredentialKeys(tx, spaceId, candidateKeys);
  for (const credentialKey of toDelete) {
    await tx.execute(sql`
      DELETE FROM api_credentials
      WHERE credential_key = ${credentialKey} AND space_id = ${spaceId}::uuid
    `);
  }
}

/** Non-archived coding repos resolving git + the provider API through this integration's bindings. */
export async function countActiveRepoDependents(
  tx: PostgresJsDatabase,
  spaceId: string,
  apiId: string,
): Promise<number> {
  const rows = (await tx.execute(sql`
    SELECT COUNT(*)::int AS count FROM repo_bindings
    WHERE connection_binding_id IN (
      SELECT binding_id FROM api_bindings
      WHERE api_id = ${apiId} AND space_id = ${spaceId}::uuid
    )
      AND space_id = ${spaceId}::uuid
      AND status != 'archived'
  `)) as unknown as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}

export async function disableApiBinding(
  tx: PostgresJsDatabase,
  spaceId: string,
  bindingId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE api_bindings SET enabled = 0, updated_at = NOW()
    WHERE binding_id = ${bindingId} AND space_id = ${spaceId}::uuid
  `);
}

export async function disableMcpBinding(
  tx: PostgresJsDatabase,
  spaceId: string,
  bindingId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE mcp_server_bindings SET enabled = 0, updated_at = NOW()
    WHERE binding_id = ${bindingId} AND space_id = ${spaceId}::uuid
  `);
}

export async function deleteApiIntegration(
  tx: PostgresJsDatabase,
  spaceId: string,
  apiId: string,
): Promise<void> {
  const doomedBindings = (await tx.execute(sql`
    SELECT auth_json FROM api_bindings
    WHERE api_id = ${apiId} AND space_id = ${spaceId}::uuid
  `)) as unknown as Array<{ auth_json: Record<string, unknown> }>;
  const candidateKeys = collectCredentialKeys(doomedBindings.map((row) => row.auth_json));

  await tx.execute(sql`
    DELETE FROM oauth_tokens
    WHERE integration_kind = 'api'
      AND resource_key = ${apiId}
      AND owner_scope = 'space'
      AND owner_id = ${spaceId}
  `);
  await tx.execute(sql`
    DELETE FROM oauth_state
    WHERE integration_kind = 'api'
      AND resource_key = ${apiId}
      AND space_id = ${spaceId}::uuid
  `);
  await tx.execute(
    sql`DELETE FROM api_bindings WHERE api_id = ${apiId} AND space_id = ${spaceId}::uuid`,
  );
  await deleteUnreferencedCredentials(tx, spaceId, candidateKeys);
  await tx.execute(
    sql`DELETE FROM api_definitions WHERE api_id = ${apiId} AND space_id = ${spaceId}::uuid`,
  );
}

export async function deleteMcpIntegration(
  tx: PostgresJsDatabase,
  spaceId: string,
  serverId: string,
): Promise<void> {
  const doomedBindings = (await tx.execute(sql`
    SELECT auth_json FROM mcp_server_bindings
    WHERE server_id = ${serverId} AND space_id = ${spaceId}::uuid
  `)) as unknown as Array<{ auth_json: Record<string, unknown> }>;
  const candidateKeys = collectCredentialKeys(doomedBindings.map((row) => row.auth_json));

  // oauth_tokens is owner-keyed on (integration_kind, resource_key=serverId,
  // owner_scope, owner_id) — deleting the server in THIS space orphans only
  // its space-owned tokens. owner_id is text; spaceId is a uuid string.
  await tx.execute(sql`
    DELETE FROM oauth_tokens
    WHERE integration_kind = 'mcp'
      AND resource_key = ${serverId}
      AND owner_scope = 'space'
      AND owner_id = ${spaceId}
  `);
  await tx.execute(sql`
    DELETE FROM oauth_state
    WHERE integration_kind = 'mcp'
      AND resource_key = ${serverId}
      AND space_id = ${spaceId}::uuid
  `);
  await tx.execute(
    sql`DELETE FROM mcp_server_bindings WHERE server_id = ${serverId} AND space_id = ${spaceId}::uuid`,
  );
  await deleteUnreferencedCredentials(tx, spaceId, candidateKeys);
  await tx.execute(
    sql`DELETE FROM mcp_server_definitions WHERE server_id = ${serverId} AND space_id = ${spaceId}::uuid`,
  );
}
