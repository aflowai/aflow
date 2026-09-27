import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq, and } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  apiBindings,
  tenants,
  type ApiBindingRow,
} from '@aflow/database';
import { ApiBindingSchema, type ApiBinding } from '@aflow/schemas';
import {
  startConsent,
  resolveOAuthCallbackUrl,
  resolveCimdDocumentUrl,
  resolveOAuthOwner,
  type OAuthBindingTarget,
} from '@aflow/oauth';
import { getDb } from './shared.js';

const ConsentResponseSchema = z.object({
  authorizationUrl: z.string().url(),
  state: z.string(),
  expiresAt: z.string(),
});

/**
 * Consent-start route for 3-legged (`oauth2_authorization_code`) API bindings —
 * the API-surface twin of the MCP consent route (`mcp-oauth.ts`). It stamps the
 * REAL owner per the binding's identity axis (Plan 185 §9.1) and writes
 * `oauth_state` so the shared `/v1/oauth/callback` handler can finalize the same
 * way it does for MCP. The API path carries NO MCP PRM discovery descriptor:
 * the binding pins `authorizationServer` (and `tokenEndpoint`) directly, so
 * `discovery` is omitted and the AS is discovered from the pinned issuer.
 */
export function registerApiOauthRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/api/bindings/:bindingId/consent',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Start an OAuth 2.1 consent flow for an API binding',
        description:
          'Returns the authorization URL the operator UI should redirect the user to. ' +
          'The callback lands at GET /v1/oauth/callback (no auth). ' +
          'The binding must have auth.type = oauth2_authorization_code.',
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

      const bindingRows = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select()
          .from(apiBindings)
          .where(and(eq(apiBindings.bindingId, bindingId), eq(apiBindings.spaceId, space.spaceId)))
          .limit(1);
      })) as ApiBindingRow[];

      if (bindingRows.length === 0) {
        reply.code(404).send({ error: `API binding "${bindingId}" not found in this space` });
        return;
      }

      const binding = parseBindingRow(bindingRows[0]!);
      if (!binding) {
        reply.code(400).send({
          error: `API binding "${bindingId}" failed schema validation — check auth and egress fields`,
        });
        return;
      }

      if (binding.auth.type !== 'oauth2_authorization_code') {
        reply.code(400).send({
          error: `API binding "${bindingId}" has auth.type="${binding.auth.type}", which is not a consent-based OAuth flow. Use this route only for oauth2_authorization_code.`,
        });
        return;
      }
      const auth = binding.auth;

      // Stamp the REAL owner per the binding's identity axis (Plan 185 D4).
      // `user` scope captures the authenticated human (pinned, never the
      // tenant) and is gated by the tenant's self-connect policy; `space`/
      // `tenant` resolve from context and ride the api_config:write authz.
      const ctx = {
        ...(request.authUser?.userId ? { userId: request.authUser.userId } : {}),
        spaceId: space.spaceId,
        tenantId: tenant.tenantId,
      };
      const ownerResult = resolveOAuthOwner(auth.ownerScope, ctx);
      if ('needsConsent' in ownerResult) {
        reply.code(400).send({
          error: `API binding "${bindingId}" is user-scoped but the request carries no user identity. A signed-in user must connect their own account.`,
        });
        return;
      }

      if (auth.ownerScope === 'user') {
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

      const target: OAuthBindingTarget = {
        integrationKind: 'api',
        resourceKey: binding.apiId,
        bindingId: binding.bindingId,
        ownerScope: auth.ownerScope,
        ownerId: ownerResult.ownerId,
        clientScope: auth.clientScope,
        issuerKey: auth.issuerKey,
        ...(auth.clientScope === 'platform' ? { platformClientId: resolveCimdDocumentUrl() } : {}),
        ...(auth.authorizationServer ? { authorizationServer: auth.authorizationServer } : {}),
      };

      let result: Awaited<ReturnType<typeof startConsent>>;
      try {
        result = await startConsent({
          tenantId: tenant.tenantId,
          spaceId: space.spaceId,
          target,
          // No MCP PRM descriptor — the API binding pins its AS directly.
          redirectUri: resolveOAuthCallbackUrl(),
          ...(auth.scopes && auth.scopes.length > 0 ? { scopes: auth.scopes } : {}),
          ...(auth.resource ? { resource: auth.resource } : {}),
          db,
        });
      } catch (err) {
        request.log.error(
          { err: err instanceof Error ? err.message : String(err), bindingId },
          'API consent start failed',
        );
        reply.code(400).send({
          error: `API consent start failed: ${err instanceof Error ? err.message : String(err)}`,
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

function parseBindingRow(row: ApiBindingRow): ApiBinding | null {
  const scopeJson = (row.scopeJson ?? {}) as Record<string, unknown>;
  const scope = {
    ...scopeJson,
    ...(row.spaceId ? { spaceId: row.spaceId } : {}),
  };
  const raw: Record<string, unknown> = {
    bindingId: row.bindingId,
    apiId: row.apiId,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    scope,
    auth: row.authJson,
    egressPolicy: row.egressPolicyJson,
    ...(row.variableValuesJson ? { variableValues: row.variableValuesJson } : {}),
    enabled: row.enabled === 1,
  };
  const result = ApiBindingSchema.safeParse(raw);
  return result.success ? result.data : null;
}
