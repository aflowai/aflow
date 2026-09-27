import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq, and } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  mcpServerBindings,
  mcpServerDefinitions,
  tenants,
  type McpServerBindingRow,
} from '@aflow/database';
import {
  McpServerBindingSchema,
  McpServerDefinitionSchema,
  type McpServerBinding,
  type McpServerDefinition,
} from '@aflow/schemas';
import {
  startConsent,
  resolveOAuthCallbackUrl,
  resolveOAuthOwner,
  buildMcpOAuthDescriptor,
  type OAuthBindingTarget,
} from '@aflow/oauth';
import { getDb } from './shared.js';

const ConsentResponseSchema = z.object({
  authorizationUrl: z.string().url(),
  state: z.string(),
  expiresAt: z.string(),
});

export function registerMcpOauthRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/mcp/bindings/:bindingId/consent',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Start an OAuth 2.1 consent flow for an MCP binding',
        description:
          'Returns the authorization URL the operator UI should redirect the user to. ' +
          'The callback lands at GET /v1/oauth/callback (no auth). ' +
          'The binding must have auth.type in {oauth2_pkce, oauth2_cimd}.',
        params: z.object({ bindingId: z.string().max(128) }),
        response: {
          200: ConsentResponseSchema,
          400: z.object({ error: z.string() }),
          403: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const { bindingId } = request.params as { bindingId: string };

      if (!db) {
        reply.code(404).send({ error: 'Database not configured' });
        return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);

      // Load binding + definition rows. Both are scoped to (id, spaceId) per
      // the composite PK introduced in migration 84 — the same bindingId can
      // exist in multiple spaces (bundle installs in different spaces).
      const bindingRows = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select()
          .from(mcpServerBindings)
          .where(
            and(
              eq(mcpServerBindings.bindingId, bindingId),
              eq(mcpServerBindings.spaceId, space.spaceId),
            ),
          )
          .limit(1);
      })) as McpServerBindingRow[];

      if (bindingRows.length === 0) {
        reply.code(404).send({ error: `MCP binding "${bindingId}" not found in this space` });
        return;
      }

      const bindingRow = bindingRows[0]!;
      const binding = parseBindingRow(bindingRow);
      if (!binding) {
        reply.code(400).send({
          error: `MCP binding "${bindingId}" failed schema validation — check auth and policy fields`,
        });
        return;
      }

      if (binding.auth.type !== 'oauth2_pkce' && binding.auth.type !== 'oauth2_cimd') {
        reply.code(400).send({
          error: `MCP binding "${bindingId}" has auth.type="${binding.auth.type}", which is not a consent-based OAuth flow. Use this route only for oauth2_pkce or oauth2_cimd.`,
        });
        return;
      }

      const definitionRows = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select()
          .from(mcpServerDefinitions)
          .where(
            and(
              eq(mcpServerDefinitions.serverId, binding.serverId),
              eq(mcpServerDefinitions.spaceId, space.spaceId),
            ),
          )
          .limit(1);
      })) as Array<{ definitionJson?: unknown }>;

      if (definitionRows.length === 0) {
        reply.code(404).send({
          error: `MCP server definition "${binding.serverId}" not found in this space for binding "${bindingId}"`,
        });
        return;
      }
      const definition = parseDefinitionRow(definitionRows[0]!);
      if (!definition) {
        reply.code(400).send({
          error: `MCP server definition "${binding.serverId}" failed schema validation`,
        });
        return;
      }

      // Stamp the REAL owner per the binding's identity axis. `user` scope
      // captures the authenticated human (pinned, never the tenant) and is
      // gated by the tenant's self-connect policy; `space`/`tenant` resolve
      // from context and ride the api_config:write authz already enforced.
      const ctx = {
        ...(request.authUser?.userId ? { userId: request.authUser.userId } : {}),
        spaceId: space.spaceId,
        tenantId: tenant.tenantId,
      };
      const ownerResult = resolveOAuthOwner(binding.ownerScope, ctx);
      if ('needsConsent' in ownerResult) {
        reply.code(400).send({
          error: `MCP binding "${bindingId}" is user-scoped but the request carries no user identity. A signed-in user must connect their own account.`,
        });
        return;
      }

      if (binding.ownerScope === 'user') {
        if (request.authUser?.isServicePrincipal) {
          reply.code(403).send({
            error:
              'User-scoped OAuth bindings can only be connected by a human user, not a service principal.',
          });
          return;
        }
        const policyRows = await db
          .select({ allowSelfConnect: tenants.oauthAllowUserSelfConnect })
          .from(tenants)
          .where(eq(tenants.tenantId, tenant.tenantId))
          .limit(1);
        if (policyRows[0]?.allowSelfConnect === false) {
          reply.code(403).send({
            error: `This tenant does not permit end-users to self-connect OAuth accounts. Ask a tenant admin to enable it or use a space/tenant-scoped binding.`,
          });
          return;
        }
      }

      const descriptor = buildMcpOAuthDescriptor(binding, definition);
      const target: OAuthBindingTarget = {
        integrationKind: 'mcp',
        resourceKey: binding.serverId,
        bindingId: binding.bindingId,
        ownerScope: binding.ownerScope,
        ownerId: ownerResult.ownerId,
        clientScope: binding.clientScope,
        issuerKey: descriptor.issuerKey,
        ...(binding.clientScope === 'platform'
          ? { platformClientId: descriptor.platformClientId }
          : {}),
      };

      let result: Awaited<ReturnType<typeof startConsent>>;
      try {
        result = await startConsent({
          tenantId: tenant.tenantId,
          spaceId: space.spaceId,
          target,
          discovery: descriptor.discovery,
          redirectUri: resolveOAuthCallbackUrl(),
          db,
        });
      } catch (err) {
        request.log.error(
          { err: err instanceof Error ? err.message : String(err), bindingId },
          'MCP consent start failed',
        );
        reply.code(400).send({
          error: `MCP consent start failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      reply.send({
        authorizationUrl: result.authorizationUrl,
        state: result.state,
        expiresAt: result.expiresAt.toISOString(),
      });
    },
  );
}

// ----------------------------------------------------------------------------
// Row → Zod parse helpers (mirror tenantLoader.ts in the MCP executor)
// ----------------------------------------------------------------------------

function parseBindingRow(row: Record<string, unknown>): McpServerBinding | null {
  const rowSpaceId =
    typeof row['spaceId'] === 'string'
      ? row['spaceId']
      : typeof row['space_id'] === 'string'
        ? row['space_id']
        : undefined;
  const rawScope = (row['scopeJson'] ?? row['scope_json'] ?? {}) as Record<string, unknown>;
  const scope = { ...rawScope, ...(rowSpaceId ? { spaceId: rowSpaceId } : {}) };

  const raw: Record<string, unknown> = {
    bindingId: row['bindingId'] ?? row['binding_id'],
    serverId: row['serverId'] ?? row['server_id'],
    name: row['name'],
    ...(row['description'] ? { description: row['description'] } : {}),
    scope,
    auth: row['authJson'] ?? row['auth_json'],
    connectionPolicy: row['connectionPolicyJson'] ?? row['connection_policy_json'] ?? {},
    ...((row['toolAccessPolicyJson'] ?? row['tool_access_policy_json'])
      ? { toolAccessPolicy: row['toolAccessPolicyJson'] ?? row['tool_access_policy_json'] }
      : {}),
    subscribeListChanged: (row['subscribeListChanged'] ?? row['subscribe_list_changed']) === 1,
    samplingPolicy:
      ((row['samplingPolicy'] ?? row['sampling_policy']) as string | undefined) ?? 'off',
    ownerScope: (row['ownerScope'] ?? row['owner_scope']) as string | undefined,
    clientScope: (row['clientScope'] ?? row['client_scope']) as string | undefined,
    ...((row['pinnedOrigin'] ?? row['pinned_origin'])
      ? { pinnedOrigin: row['pinnedOrigin'] ?? row['pinned_origin'] }
      : {}),
    enabled: (row['enabled'] ?? 1) === 1,
  };
  const result = McpServerBindingSchema.safeParse(raw);
  return result.success ? result.data : null;
}

function parseDefinitionRow(row: { definitionJson?: unknown }): McpServerDefinition | null {
  const result = McpServerDefinitionSchema.safeParse(row.definitionJson ?? {});
  return result.success ? result.data : null;
}
