/**
 * The private network acknowledgment's one writer (Plan 336 D2, D5, D7).
 *
 * The record lives in its own column, apart from the definition an agent can
 * upsert. It is written here and nowhere else, and every change writes a
 * `tenant_audit_log` row in the same transaction.
 */
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  MCP_PRIVATE_NETWORK_AUDIT_ACTIONS,
  MCP_PRIVATE_NETWORK_HOSTS_ENV,
  normalizePrivateNetworkHost,
  parseMcpPrivateNetworkAcknowledgment,
  privateNetworkHostProblem,
  processEditionDescriptor,
  type EditionId,
  type McpPrivateNetworkAcknowledgment,
  type McpPrivateNetworkSetResult,
  type TenantId,
} from '@aflow/schemas';
import { isCloudMetadataHostname, unliftableRangeOf } from '@aflow/network-safety';
import { createTenantContext, withTenantSchema } from '@aflow/database';
import { publishMcpCatalogInvalidation } from '@aflow/redis';
import type { McpIntegrationAdminScope } from './mcpIntegrationAdmin.js';

/** Who changed the record, as `tenant_audit_log` records an actor. */
export interface PrivateNetworkAuditActor {
  /** A user id. A value that is not a UUID is kept in `details` instead. */
  actorId: string | null;
  actorKind: 'human' | 'service_principal' | 'system';
  /** The run and step that made the change, when an agent run made it. */
  run?: { runId: string; stepExecutionId: string };
}

export type McpPrivateNetworkWriteErrorCode =
  'MCP_SERVER_NOT_FOUND' | 'PRIVATE_NETWORK_HOST_REFUSED' | 'PRIVATE_NETWORK_HOST_NOT_LISTED';

export class McpPrivateNetworkWriteError extends Error {
  constructor(
    readonly code: McpPrivateNetworkWriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'McpPrivateNetworkWriteError';
  }
}

type ExecuteTx = Pick<PostgresJsDatabase, 'execute'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function unliftableRangeProblem(host: string): string | null {
  const label = unliftableRangeOf(host);
  return label === null
    ? null
    : `is in a range the platform never admits (${label}), which no setting reaches`;
}

/**
 * The hosts as they will be stored, or the reason the write is refused. The
 * local edition accepts a host as set. The hosted edition refuses one its
 * deployment does not list, because the executor would refuse it at connect.
 */
export function privateNetworkHostsForWrite(input: {
  hosts: readonly string[];
  edition: EditionId;
  deploymentHosts: readonly string[];
}): string[] {
  const hosts = [...new Set(input.hosts.map(normalizePrivateNetworkHost))];
  for (const host of hosts) {
    const problem = isCloudMetadataHostname(host)
      ? 'names a cloud metadata service, which no setting reaches'
      : (privateNetworkHostProblem(host) ?? unliftableRangeProblem(host));
    if (problem !== null) {
      throw new McpPrivateNetworkWriteError(
        'PRIVATE_NETWORK_HOST_REFUSED',
        `"${host}" ${problem}.`,
      );
    }
  }
  if (input.edition === 'enterprise') {
    const listed = new Set(input.deploymentHosts.map(normalizePrivateNetworkHost));
    const unlisted = hosts.filter((host) => !listed.has(host));
    if (unlisted.length > 0) {
      throw new McpPrivateNetworkWriteError(
        'PRIVATE_NETWORK_HOST_NOT_LISTED',
        `This deployment does not list ${unlisted.map((h) => `"${h}"`).join(', ')} in ` +
          `${MCP_PRIVATE_NETWORK_HOSTS_ENV}. In the hosted edition a private address may be ` +
          `the platform's own network, so whoever runs the deployment must add the host to ` +
          `${MCP_PRIVATE_NETWORK_HOSTS_ENV} first.`,
      );
    }
  }
  return hosts;
}

function sameHosts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
}

/** Writes one audit row for a change to the record. */
export async function writeMcpPrivateNetworkAudit(
  tx: ExecuteTx,
  row: {
    spaceId: string;
    serverId: string;
    actor: PrivateNetworkAuditActor;
    action: (typeof MCP_PRIVATE_NETWORK_AUDIT_ACTIONS)[keyof typeof MCP_PRIVATE_NETWORK_AUDIT_ACTIONS];
    hostsBefore: readonly string[];
    hostsAfter: readonly string[];
    edition: EditionId;
    cause: 'route' | 'definition_deleted' | 'space_archived';
  },
): Promise<void> {
  const actorId =
    row.actor.actorId !== null && UUID.test(row.actor.actorId) ? row.actor.actorId : null;
  const details = {
    serverId: row.serverId,
    hostsBefore: row.hostsBefore,
    hostsAfter: row.hostsAfter,
    edition: row.edition,
    cause: row.cause,
    ...(actorId === null && row.actor.actorId !== null ? { actor: row.actor.actorId } : {}),
    ...(row.actor.run
      ? { runId: row.actor.run.runId, stepExecutionId: row.actor.run.stepExecutionId }
      : {}),
  };
  await tx.execute(sql`
    INSERT INTO tenant_audit_log (
      actor_id, actor_kind, category, action, outcome,
      resource_type, resource_id, space_id, details
    )
    VALUES (
      ${actorId}::uuid,
      ${row.actor.actorKind},
      'security',
      ${row.action},
      'success',
      'mcp_server_definition',
      ${row.serverId},
      ${row.spaceId}::uuid,
      ${JSON.stringify(details)}::jsonb
    )
  `);
}

/**
 * Deletes every MCP server definition in an archived space. Each one that held
 * a private network acknowledgment leaves a `cleared` audit row, because the
 * archive withdrew that access as surely as clearing it would.
 */
export async function deleteArchivedSpaceMcpDefinitions(
  tx: ExecuteTx,
  spaceId: string,
  actor: PrivateNetworkAuditActor,
): Promise<void> {
  const deleted = (await tx.execute(sql`
    DELETE FROM mcp_server_definitions WHERE space_id = ${spaceId}::uuid
    RETURNING server_id, private_network_json
  `)) as unknown as Array<{ server_id: string; private_network_json: unknown }>;
  for (const row of deleted) {
    const record = parseMcpPrivateNetworkAcknowledgment(row.private_network_json);
    if (record === null) continue;
    await writeMcpPrivateNetworkAudit(tx, {
      spaceId,
      serverId: row.server_id,
      actor,
      action: MCP_PRIVATE_NETWORK_AUDIT_ACTIONS.cleared,
      hostsBefore: record.hosts,
      hostsAfter: [],
      edition: processEditionDescriptor().edition,
      cause: 'space_archived',
    });
  }
}

/**
 * Sets the definition's private network hosts, or clears them with an empty
 * list. Writing the hosts already stored changes nothing and writes no row.
 */
export async function setMcpPrivateNetwork(
  opts: McpIntegrationAdminScope & {
    serverId: string;
    hosts: readonly string[];
    actor: PrivateNetworkAuditActor & { actorId: string };
    edition?: EditionId;
    deploymentHosts: readonly string[];
    now?: Date;
  },
): Promise<McpPrivateNetworkSetResult> {
  const edition = opts.edition ?? processEditionDescriptor().edition;
  const hosts = privateNetworkHostsForWrite({
    hosts: opts.hosts,
    edition,
    deploymentHosts: opts.deploymentHosts,
  });

  const result = await withTenantSchema(
    opts.db,
    createTenantContext(opts.tenantId as TenantId),
    async (tx): Promise<McpPrivateNetworkSetResult> => {
      const rows = (await tx.execute(sql`
        SELECT private_network_json FROM mcp_server_definitions
        WHERE server_id = ${opts.serverId} AND space_id = ${opts.spaceId}::uuid
        FOR UPDATE
      `)) as unknown as Array<{ private_network_json: unknown }>;
      if (rows.length === 0) {
        throw new McpPrivateNetworkWriteError(
          'MCP_SERVER_NOT_FOUND',
          `MCP server definition "${opts.serverId}" not found in this space.`,
        );
      }
      const before = parseMcpPrivateNetworkAcknowledgment(rows[0]?.private_network_json);
      const hostsBefore = before?.hosts ?? [];
      if (sameHosts(hostsBefore, hosts)) {
        return { serverId: opts.serverId, action: 'unchanged', privateNetwork: before };
      }

      const after: McpPrivateNetworkAcknowledgment | null =
        hosts.length === 0
          ? null
          : {
              hosts,
              setBy: opts.actor.actorId,
              setAt: (opts.now ?? new Date()).toISOString(),
            };
      await tx.execute(sql`
        UPDATE mcp_server_definitions
        SET private_network_json = ${after === null ? null : JSON.stringify(after)}::jsonb,
            updated_at = NOW()
        WHERE server_id = ${opts.serverId} AND space_id = ${opts.spaceId}::uuid
      `);
      const action =
        after === null
          ? MCP_PRIVATE_NETWORK_AUDIT_ACTIONS.cleared
          : MCP_PRIVATE_NETWORK_AUDIT_ACTIONS.set;
      await writeMcpPrivateNetworkAudit(tx, {
        spaceId: opts.spaceId,
        serverId: opts.serverId,
        actor: opts.actor,
        action,
        hostsBefore,
        hostsAfter: hosts,
        edition,
        cause: 'route',
      });
      return {
        serverId: opts.serverId,
        action: after === null ? 'cleared' : 'set',
        privateNetwork: after,
      };
    },
  );

  if (result.action !== 'unchanged' && opts.redis) {
    publishMcpCatalogInvalidation(opts.redis, opts.tenantId, opts.spaceId, {
      kind: 'definition',
      serverId: opts.serverId,
    });
  }
  return result;
}
