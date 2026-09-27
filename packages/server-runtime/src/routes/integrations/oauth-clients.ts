import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq, and } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  oauthClients,
  encryptCredentialEnvelope,
  type OauthClientRow,
} from '@aflow/database';
import {
  OAuthClientCreateInputSchema,
  OAuthClientCreateResponseSchema,
  OAuthClientListResponseSchema,
  OAuthClientGetResponseSchema,
  OAuthClientRotateSecretInputSchema,
  OAuthClientRotateSecretResponseSchema,
  OAuthClientDeleteResponseSchema,
  getOAuthIssuer,
  type OAuthClientMeta,
} from '@aflow/schemas';
import { classifyDbError } from '../../lib/databaseErrors.js';
import { getDb } from './shared.js';

// ---------------------------------------------------------------------------
// Shared row mapper — the client_secret is WRITE-ONLY, surfaced only as
// `hasSecret` (its presence), never returned.
// ---------------------------------------------------------------------------

export function mapOAuthClientRow(row: OauthClientRow): OAuthClientMeta {
  return {
    id: row.id,
    scope: row.scope as OAuthClientMeta['scope'],
    scopeId: row.scopeId,
    issuerKey: row.issuerKey,
    clientId: row.clientId,
    label: row.label,
    hasSecret: Boolean(row.encryptedClientSecret),
    authorizationServer: row.authorizationServer ?? null,
    defaultScopes: row.defaultScopesJson,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const ErrorSchema = z.object({ error: z.string() });
const ConflictSchema = z.object({ error: z.string(), message: z.string() });

// ---------------------------------------------------------------------------
// Space-scoped OAuth client routes (space admin only) — under the space
// integrations surface. Tenant-scoped clients live in tenant-settings.ts.
// ---------------------------------------------------------------------------

export function registerOAuthClientRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ── GET /mcp|api integrations surface: list space OAuth clients ──────────
  app.get(
    '/oauth-clients',
    {
      config: { authz: { resource: 'api_config', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'List OAuth client apps registered for the current space',
        response: { 200: OAuthClientListResponseSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      if (!db) {
        reply.send({ clients: [] });
        return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);
      const rows = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select()
          .from(oauthClients)
          .where(and(eq(oauthClients.scope, 'space'), eq(oauthClients.scopeId, space.spaceId)));
      })) as OauthClientRow[];

      reply.send({ clients: rows.map(mapOAuthClientRow) });
    },
  );

  // ── POST: register a new space OAuth client ──────────────────────────────
  app.post(
    '/oauth-clients',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Register an OAuth client app for the current space (space admin only)',
        description:
          'The client_secret is encrypted at rest (AES-256-GCM envelope) and never returned.',
        body: OAuthClientCreateInputSchema.omit({ scope: true, scopeId: true }),
        response: {
          201: OAuthClientCreateResponseSchema,
          400: ErrorSchema,
          403: ErrorSchema,
          409: ConflictSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();

      if (request.authUser?.isServicePrincipal) {
        reply.status(403).send({ error: 'OAuth client apps can only be managed by human users' });
        return;
      }
      if (!space.isSpaceAdmin) {
        reply.status(403).send({ error: 'Space-scoped OAuth clients require space admin role' });
        return;
      }

      const db = getDb(fastify);
      if (!db) {
        reply.status(403).send({ error: 'Database not configured' });
        return;
      }

      const userId = request.authUser?.userId;
      if (!userId) {
        reply.status(403).send({ error: 'Authentication required' });
        return;
      }

      const body = request.body;
      if (!getOAuthIssuer(body.issuerKey) && !body.authorizationServer) {
        reply.status(400).send({
          error: `Unknown issuer "${body.issuerKey}". Supply authorizationServer for an unregistered issuer.`,
        });
        return;
      }

      const encryptedClientSecret = body.clientSecret
        ? await encryptCredentialEnvelope(body.clientSecret)
        : null;

      const tenantContext = createTenantContext(tenant.tenantId);
      try {
        const rows = await withTenantSchema(db, tenantContext, async (tx) => {
          return tx
            .insert(oauthClients)
            .values({
              scope: 'space',
              scopeId: space.spaceId,
              issuerKey: body.issuerKey,
              clientId: body.clientId,
              encryptedClientSecret,
              authorizationServer: body.authorizationServer ?? null,
              defaultScopesJson: body.defaultScopes ?? [],
              label: body.label,
              createdBy: userId,
            })
            .returning();
        });

        const row = rows[0]!;
        reply.status(201).send({ client: mapOAuthClientRow(row) });
      } catch (error) {
        const classified = classifyDbError(error, 'register OAuth client');
        if (classified.statusCode === 409) {
          reply.status(409).send({
            error: 'oauth_client_conflict',
            message: `An OAuth client for issuer "${body.issuerKey}" is already registered in this space.`,
          });
          return;
        }
        throw classified;
      }
    },
  );

  // ── GET /:id: read a single space OAuth client ───────────────────────────
  app.get(
    '/oauth-clients/:id',
    {
      config: { authz: { resource: 'api_config', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Get a single space OAuth client app',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: OAuthClientGetResponseSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      if (!db) {
        reply.status(404).send({ error: 'OAuth client not found' });
        return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);
      const rows = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select()
          .from(oauthClients)
          .where(
            and(
              eq(oauthClients.id, request.params.id),
              eq(oauthClients.scope, 'space'),
              eq(oauthClients.scopeId, space.spaceId),
            ),
          )
          .limit(1);
      })) as OauthClientRow[];

      const row = rows[0];
      if (!row) {
        reply.status(404).send({ error: 'OAuth client not found' });
        return;
      }
      reply.send({ client: mapOAuthClientRow(row) });
    },
  );

  // ── POST /:id/rotate-secret: replace the stored client secret ────────────
  app.post(
    '/oauth-clients/:id/rotate-secret',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Rotate a space OAuth client secret (space admin only)',
        params: z.object({ id: z.string().uuid() }),
        body: OAuthClientRotateSecretInputSchema,
        response: {
          200: OAuthClientRotateSecretResponseSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();

      if (request.authUser?.isServicePrincipal) {
        reply.status(403).send({ error: 'OAuth client apps can only be managed by human users' });
        return;
      }
      if (!space.isSpaceAdmin) {
        reply.status(403).send({ error: 'Space-scoped OAuth clients require space admin role' });
        return;
      }

      const db = getDb(fastify);
      if (!db) {
        reply.status(404).send({ error: 'OAuth client not found' });
        return;
      }

      const encryptedClientSecret = await encryptCredentialEnvelope(request.body.clientSecret);
      const tenantContext = createTenantContext(tenant.tenantId);
      const rows = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .update(oauthClients)
          .set({ encryptedClientSecret, updatedAt: new Date() })
          .where(
            and(
              eq(oauthClients.id, request.params.id),
              eq(oauthClients.scope, 'space'),
              eq(oauthClients.scopeId, space.spaceId),
            ),
          )
          .returning();
      })) as OauthClientRow[];

      const row = rows[0];
      if (!row) {
        reply.status(404).send({ error: 'OAuth client not found' });
        return;
      }
      reply.send({ client: mapOAuthClientRow(row) });
    },
  );

  // ── DELETE /:id: remove a space OAuth client ─────────────────────────────
  app.delete(
    '/oauth-clients/:id',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Delete a space OAuth client app (space admin only)',
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: OAuthClientDeleteResponseSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();

      if (request.authUser?.isServicePrincipal) {
        reply.status(403).send({ error: 'OAuth client apps can only be managed by human users' });
        return;
      }
      if (!space.isSpaceAdmin) {
        reply.status(403).send({ error: 'Space-scoped OAuth clients require space admin role' });
        return;
      }

      const db = getDb(fastify);
      if (!db) {
        reply.status(404).send({ error: 'OAuth client not found' });
        return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);
      const deleted = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .delete(oauthClients)
          .where(
            and(
              eq(oauthClients.id, request.params.id),
              eq(oauthClients.scope, 'space'),
              eq(oauthClients.scopeId, space.spaceId),
            ),
          )
          .returning({ id: oauthClients.id });
      })) as Array<{ id: string }>;

      if (deleted.length === 0) {
        reply.status(404).send({ error: 'OAuth client not found' });
        return;
      }
      reply.send({ id: request.params.id, deleted: true });
    },
  );
}
