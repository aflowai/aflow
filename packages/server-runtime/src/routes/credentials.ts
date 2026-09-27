import type { FastifyPluginAsync } from 'fastify';
import { classifyDbError } from '../lib/databaseErrors.js';
import {
  previewCredentialResolution,
  emptyResolutionPreview,
} from '../lib/credentialResolutionPreview.js';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq, and, inArray } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  providerCredentials,
  encryptCredentialEnvelope,
  decryptCredentialAsync,
} from '@aflow/database';
import { verifyProviderKey, isVerifiableProvider } from '@aflow/ai-client';
import { publishProviderCredentialInvalidation } from '@aflow/redis';
import {
  ProviderIdSchema,
  CredentialScopeSchema,
  CredentialMetaSchema,
  CredentialStatusSchema,
  ProviderDefinitionSchema,
  getAllProviders,
  getProviderDefinition,
  isAllowedFieldOrigin,
  getSecretFieldIds,
  getConfigFieldIds,
  getRequiredFieldIds,
} from '@aflow/schemas';
import type { CredentialScope } from '@aflow/schemas';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';

function getDb(fastify: { appContext?: { db?: unknown } }) {
  return (fastify.appContext?.db ?? null) as PostgresJsDatabase | null;
}

function getRedis(fastify: { appContext?: { redis?: unknown } }) {
  return (fastify.appContext?.redis ?? null) as Redis | null;
}

function mapRow(
  row: typeof providerCredentials.$inferSelect,
): z.infer<typeof CredentialMetaSchema> {
  return {
    id: row.id,
    providerId: row.providerId as z.infer<typeof ProviderIdSchema>,
    scope: row.scope as CredentialScope,
    scopeId: row.scopeId,
    label: row.label,
    configJson: (row.configJson ?? {}) as Record<string, unknown>,
    hasSecrets: Boolean(row.encryptedSecrets),
    status: (row.status ?? 'active') as 'active' | 'error',
    lastValidatedAt: row.lastValidatedAt?.toISOString() ?? null,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Validate secrets and config against the provider's field definitions.
 * Returns an error string if validation fails, or null if valid.
 */
/**
 * Origins a deployment permits beyond each field's own list, comma-separated.
 * The escape hatch for a corporate gateway or a self-hosted proxy — set by
 * whoever runs the deployment, deliberately NOT by a tenant admin through the
 * API, since the whole point is that a credential writer cannot choose where a
 * secret is sent.
 */
function operatorAllowedOrigins(): string[] {
  return (process.env['CREDENTIAL_EXTRA_BASE_URL_ORIGINS'] ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * Refuse a config value that would point a credential at an origin the platform
 * does not deliver secrets to.
 *
 * Config is writable WITHOUT re-entering the secret, so an unconstrained URL
 * field lets someone who has never seen a key redirect it to a host they
 * control. Asking for the secret back would only stop a writer who lacks it —
 * not one who mistyped, and not one who was talked into it. Constraining the
 * destination covers all three, so it is enforced on every write path.
 */
function validateFieldOrigins(providerId: string, config?: Record<string, string>): string | null {
  if (!config) return null;
  const definition = getProviderDefinition(providerId);
  if (!definition) return null;
  const extra = operatorAllowedOrigins();
  for (const field of definition.fields) {
    const value = config[field.fieldId];
    if (value === undefined || value === '') continue;
    if (!isAllowedFieldOrigin(field, value, extra)) {
      return `${field.label} must point at an approved origin for ${providerId} (allowed: ${(field.allowedOrigins ?? []).join(', ')}).`;
    }
  }
  return null;
}

function validateProviderFields(
  providerId: string,
  secrets: Record<string, string>,
  config?: Record<string, string>,
): string | null {
  const secretFieldIds = getSecretFieldIds(providerId);
  const configFieldIds = getConfigFieldIds(providerId);
  const requiredFieldIds = getRequiredFieldIds(providerId);

  // Check required secret fields are present and non-empty
  const missingSecrets = requiredFieldIds
    .filter((f) => secretFieldIds.includes(f))
    .filter((f) => !secrets[f]);
  if (missingSecrets.length > 0) {
    return `Missing required secret fields: ${missingSecrets.join(', ')}`;
  }

  // Check required config fields
  const requiredConfigFields = requiredFieldIds.filter((f) => configFieldIds.includes(f));
  if (requiredConfigFields.length > 0) {
    const missingConfig = requiredConfigFields.filter((f) => !config?.[f]);
    if (missingConfig.length > 0) {
      return `Missing required config fields: ${missingConfig.join(', ')}`;
    }
  }

  // Reject unknown secret keys
  const unknownSecrets = Object.keys(secrets).filter((k) => !secretFieldIds.includes(k));
  if (unknownSecrets.length > 0) {
    return `Unknown secret fields for ${providerId}: ${unknownSecrets.join(', ')}`;
  }

  // Reject unknown config keys
  if (config) {
    const unknownConfig = Object.keys(config).filter((k) => !configFieldIds.includes(k));
    if (unknownConfig.length > 0) {
      return `Unknown config fields for ${providerId}: ${unknownConfig.join(', ')}`;
    }
  }

  return validateFieldOrigins(providerId, config);
}

function invalidateCredentialCache(fastify: unknown, tenantId: string): void {
  const redis = getRedis(fastify as { appContext?: { redis?: unknown } });
  if (redis) {
    publishProviderCredentialInvalidation(redis, tenantId);
  }
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export const credentialRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Auth required for all credential routes
  app.addHook('preHandler', app.authenticate);

  // ── GET /v1/credentials/providers ──────────────────────────────────────

  app.get(
    '/providers',
    {
      config: { authz: { resource: 'credential', action: 'read' } },
      schema: {
        tags: ['Credentials'],
        summary: 'List all available providers',
        response: {
          200: z.object({ providers: z.array(ProviderDefinitionSchema) }),
        },
      },
    },
    async (request, reply) => {
      await request.requireTenant();
      reply.send({ providers: [...getAllProviders()] });
    },
  );

  // ── GET /v1/credentials/providers/:providerId ──────────────────────────

  app.get(
    '/providers/:providerId',
    {
      config: { authz: { resource: 'credential', action: 'read' } },
      schema: {
        tags: ['Credentials'],
        summary: 'Get a single provider definition',
        params: z.object({ providerId: ProviderIdSchema }),
        response: {
          200: ProviderDefinitionSchema,
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      await request.requireTenant();
      const { providerId } = request.params;
      const def = getProviderDefinition(providerId);
      if (!def) {
        reply.status(404).send({ error: `Provider not found: ${providerId}` });
        return;
      }
      reply.send(def);
    },
  );

  // ── GET /v1/credentials ────────────────────────────────────────────────
  //
  // Returns all credentials visible in the user's current context:
  //   - user's own credentials (scope=user, scopeId=userId)
  //   - current space credentials (scope=space, scopeId=spaceId from header)
  //   - tenant credentials (scope=tenant, scopeId=tenantId)
  //
  // Requires space context (X-Space-ID header) so the UI shows the right
  // space-scope credentials.

  app.get(
    '/',
    {
      config: { authz: { resource: 'credential', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Credentials'],
        summary: 'List all visible credentials (user + current space + tenant)',
        querystring: z.object({
          providerId: ProviderIdSchema.optional(),
        }),
        response: {
          200: z.object({ credentials: z.array(CredentialMetaSchema) }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      if (!db) {
        reply.send({ credentials: [] });
        return;
      }

      const userId = request.authUser!.userId as string;
      const spaceId = space.spaceId as string;
      const tenantId = tenant.tenantId as string;
      const { providerId } = request.query;

      const tenantContext = createTenantContext(tenant.tenantId);

      // Query rows visible to this user: their own + current space + tenant
      let typedRows: Array<typeof providerCredentials.$inferSelect>;
      try {
        const rows = await withTenantSchema(db, tenantContext, async (tx) => {
          const scopeFilter = inArray(providerCredentials.scopeId, [userId, spaceId, tenantId]);
          const conditions = providerId
            ? and(scopeFilter, eq(providerCredentials.providerId, providerId))
            : scopeFilter;
          return tx.select().from(providerCredentials).where(conditions);
        });
        typedRows = rows as Array<typeof providerCredentials.$inferSelect>;
      } catch {
        // Table may not exist yet (migration 23 not applied)
        reply.send({ credentials: [] });
        return;
      }

      // Defense in depth: filter to only rows matching the expected scope/scopeId pairs
      const visibleRows = typedRows.filter((r) => {
        if (r.scope === 'user') return r.scopeId === userId;
        if (r.scope === 'space') return r.scopeId === spaceId;
        if (r.scope === 'tenant') return r.scopeId === tenantId;
        return false;
      });

      reply.send({ credentials: visibleRows.map(mapRow) });
    },
  );

  // ── PUT /v1/credentials/:providerId ────────────────────────────────────
  //
  // scope determines where the credential is stored:
  //   - 'user':   stored for the authenticated user (any human user)
  //   - 'space':  stored for the current space (requires space admin)
  //   - 'tenant': stored for the tenant (requires tenant admin)
  //
  // scopeId is derived from context, never user-supplied.

  app.put(
    '/:providerId',
    {
      config: { authz: { resource: 'credential', action: 'write' } },
      schema: {
        tags: ['Credentials'],
        summary: 'Create or update a provider credential bundle (atomic)',
        params: z.object({ providerId: ProviderIdSchema }),
        body: z.object({
          scope: CredentialScopeSchema,
          secrets: z.record(z.string()),
          config: z.record(z.string()).optional(),
          label: z.string().max(256).optional(),
        }),
        response: {
          200: CredentialMetaSchema,
          400: z.object({ error: z.string() }),
          403: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = getDb(fastify);
      if (!db) {
        reply.status(500).send({ error: 'Database not configured' });
        return;
      }

      const { providerId } = request.params;
      const { scope, secrets, config, label } = request.body;
      const userId = request.authUser?.userId;
      if (!userId) throw new Error('Authentication required');

      // Human-only: service principals cannot manage credentials
      if (request.authUser?.isServicePrincipal) {
        reply.status(403).send({ error: 'Credentials can only be managed by human users' });
        return;
      }

      // Derive scopeId from context based on scope
      let scopeId: string;
      switch (scope) {
        case 'user':
          scopeId = userId as string;
          break;
        case 'space': {
          const space = await request.requireSpace();
          if (!space.isSpaceAdmin) {
            reply.status(403).send({ error: 'Space-scoped credentials require space admin role' });
            return;
          }
          scopeId = space.spaceId as string;
          break;
        }
        case 'tenant':
          if (!tenant.isAdmin) {
            reply
              .status(403)
              .send({ error: 'Tenant-scoped credentials require tenant admin role' });
            return;
          }
          scopeId = tenant.tenantId as string;
          break;
        default:
          reply.status(400).send({ error: `Invalid scope: ${scope as string}` });
          return;
      }

      // Validate provider exists
      const def = getProviderDefinition(providerId);
      if (!def) {
        reply.status(400).send({ error: `Unknown provider: ${providerId}` });
        return;
      }

      // Validate fields against provider schema
      const fieldError = validateProviderFields(providerId, secrets, config);
      if (fieldError) {
        reply.status(400).send({ error: fieldError });
        return;
      }

      // Encrypt secret fields as JSON bundle
      const secretsJson = JSON.stringify(secrets);
      const encryptedSecrets = await encryptCredentialEnvelope(secretsJson);

      const tenantContext = createTenantContext(tenant.tenantId);

      try {
        const rows = await withTenantSchema(db, tenantContext, async (tx) => {
          return tx
            .insert(providerCredentials)
            .values({
              providerId,
              scope,
              scopeId,
              encryptedSecrets,
              configJson: config ?? {},
              label: label ?? null,
              createdBy: userId,
              status: 'active',
              lastErrorAt: null,
              lastErrorCode: null,
            })
            .onConflictDoUpdate({
              target: [
                providerCredentials.providerId,
                providerCredentials.scope,
                providerCredentials.scopeId,
              ],
              set: {
                encryptedSecrets,
                configJson: config ?? {},
                label: label ?? null,
                status: 'active',
                lastErrorAt: null,
                lastErrorCode: null,
                // The bytes changed, so nothing has tried these. Carrying the
                // previous secret's verification forward would report a
                // replacement key as checked and let every gate that reads it
                // close on an untested one.
                lastValidatedAt: null,
                updatedAt: new Date(),
              },
            })
            .returning();
        });

        const row = rows[0];
        invalidateCredentialCache(fastify, tenant.tenantId as string);
        reply.send(mapRow(row!));
      } catch (error) {
        reply.log.error({ err: error }, 'Credential save failed');
        throw classifyDbError(error, 'save credential');
      }
    },
  );

  // ── PATCH /v1/credentials/:providerId ──────────────────────────────────
  //
  // Update config fields only (no secret re-entry needed).
  // Same scope/auth rules as PUT.

  app.patch(
    '/:providerId',
    {
      config: { authz: { resource: 'credential', action: 'write' } },
      schema: {
        tags: ['Credentials'],
        summary: 'Update config fields only (no secret re-entry needed)',
        params: z.object({ providerId: ProviderIdSchema }),
        body: z.object({
          scope: CredentialScopeSchema,
          config: z.record(z.string()),
          label: z.string().max(256).optional(),
        }),
        response: {
          200: CredentialMetaSchema,
          400: z.object({ error: z.string() }),
          403: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = getDb(fastify);
      if (!db) throw new Error('Database not configured');

      const { providerId } = request.params;
      const { scope, config, label } = request.body;
      const userId = request.authUser?.userId;
      if (!userId) throw new Error('Authentication required');

      if (request.authUser?.isServicePrincipal) {
        reply.status(403).send({ error: 'Credentials can only be managed by human users' });
        return;
      }

      // Derive scopeId from context
      let scopeId: string;
      switch (scope) {
        case 'user':
          scopeId = userId as string;
          break;
        case 'space': {
          const space = await request.requireSpace();
          if (!space.isSpaceAdmin) {
            reply.status(403).send({ error: 'Space-scoped credentials require space admin role' });
            return;
          }
          scopeId = space.spaceId as string;
          break;
        }
        case 'tenant':
          if (!tenant.isAdmin) {
            reply
              .status(403)
              .send({ error: 'Tenant-scoped credentials require tenant admin role' });
            return;
          }
          scopeId = tenant.tenantId as string;
          break;
        default:
          reply.status(400).send({ error: `Invalid scope: ${scope as string}` });
          return;
      }

      // Validate provider exists
      const def = getProviderDefinition(providerId);
      if (!def) {
        reply.status(400).send({ error: `Unknown provider: ${providerId}` });
        return;
      }

      // Validate config keys against provider schema
      const configFieldIds = getConfigFieldIds(providerId);
      const unknownConfig = Object.keys(config).filter((k) => !configFieldIds.includes(k));
      if (unknownConfig.length > 0) {
        reply.status(400).send({
          error: `Unknown config fields for ${providerId}: ${unknownConfig.join(', ')}`,
        });
        return;
      }

      // This route updates config WITHOUT the secret, so it is the path a
      // redirect would take.
      const originError = validateFieldOrigins(providerId, config);
      if (originError) {
        reply.status(400).send({ error: originError });
        return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);

      try {
        const rows = await withTenantSchema(db, tenantContext, async (tx) => {
          // Read existing row to merge config (PATCH is additive, not a replacement)
          const existing = await tx
            .select({ configJson: providerCredentials.configJson })
            .from(providerCredentials)
            .where(
              and(
                eq(providerCredentials.providerId, providerId),
                eq(providerCredentials.scope, scope),
                eq(providerCredentials.scopeId, scopeId),
              ),
            )
            .limit(1);

          if (existing.length === 0) return [];

          const mergedConfig = {
            ...((existing[0]!.configJson as Record<string, unknown>) ?? {}),
            ...config,
          };

          const updateSet: Record<string, unknown> = {
            configJson: mergedConfig,
            updatedAt: new Date(),
          };
          if (label !== undefined) {
            updateSet['label'] = label;
          }

          return tx
            .update(providerCredentials)
            .set(updateSet)
            .where(
              and(
                eq(providerCredentials.providerId, providerId),
                eq(providerCredentials.scope, scope),
                eq(providerCredentials.scopeId, scopeId),
              ),
            )
            .returning();
        });

        const row = (rows as Array<typeof providerCredentials.$inferSelect>)[0];
        if (!row) {
          reply.status(404).send({ error: 'Credential not found' });
          return;
        }

        invalidateCredentialCache(fastify, tenant.tenantId as string);
        // Where a provider secret is delivered is security-relevant state, and it
        // was previously changeable without a trace. The allowlist above bounds
        // WHERE it can point; this records WHO moved it and WHEN.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- audit may be unset in tests
        if (fastify.audit && Object.keys(config).length > 0) {
          fastify.audit.record({
            actor: {
              userId,
              kind: 'human',
              authMethod: request.authUser?.authMethod ?? 'unknown',
              tenantId: tenant.tenantId,
              ...(tenant.tenantRole ? { tenantRole: tenant.tenantRole } : {}),
            },
            category: 'security',
            action: 'credential.config.update',
            outcome: 'success',
            target: {
              resourceType: 'credential',
              resourceId: providerId,
              tenantId: tenant.tenantId,
            },
            details: { scope, configFields: Object.keys(config).sort() },
          });
        }

        reply.send(mapRow(row));
      } catch (error) {
        reply.log.error({ err: error }, 'Credential config update failed');
        throw classifyDbError(error, 'update credential config');
      }
    },
  );

  // ── DELETE /v1/credentials/:providerId ─────────────────────────────────

  app.delete(
    '/:providerId',
    {
      config: { authz: { resource: 'credential', action: 'write' } },
      schema: {
        tags: ['Credentials'],
        summary: 'Delete a provider credential bundle',
        params: z.object({ providerId: ProviderIdSchema }),
        querystring: z.object({
          scope: CredentialScopeSchema,
        }),
        response: {
          204: z.null().describe('Deleted'),
          400: z.object({ error: z.string() }),
          403: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = getDb(fastify);
      if (!db) throw new Error('Database not configured');

      const { providerId } = request.params;
      const { scope } = request.query;
      const userId = request.authUser?.userId;
      if (!userId) throw new Error('Authentication required');

      if (request.authUser?.isServicePrincipal) {
        reply.status(403).send({ error: 'Credentials can only be managed by human users' });
        return;
      }

      // Derive scopeId from context
      let scopeId: string;
      switch (scope) {
        case 'user':
          scopeId = userId as string;
          break;
        case 'space': {
          const space = await request.requireSpace();
          if (!space.isSpaceAdmin) {
            reply.status(403).send({ error: 'Space-scoped credentials require space admin role' });
            return;
          }
          scopeId = space.spaceId as string;
          break;
        }
        case 'tenant':
          if (!tenant.isAdmin) {
            reply
              .status(403)
              .send({ error: 'Tenant-scoped credentials require tenant admin role' });
            return;
          }
          scopeId = tenant.tenantId as string;
          break;
        default:
          reply.status(400).send({ error: `Invalid scope: ${scope as string}` });
          return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);

      try {
        const deleted = await withTenantSchema(db, tenantContext, async (tx) => {
          return tx
            .delete(providerCredentials)
            .where(
              and(
                eq(providerCredentials.providerId, providerId),
                eq(providerCredentials.scope, scope),
                eq(providerCredentials.scopeId, scopeId),
              ),
            )
            .returning({ id: providerCredentials.id });
        });

        if ((deleted as Array<{ id: string }>).length === 0) {
          reply.status(404).send({ error: 'Credential not found' });
          return;
        }

        invalidateCredentialCache(fastify, tenant.tenantId as string);
        reply.status(204).send(null);
      } catch (error) {
        reply.log.error({ err: error }, 'Credential delete failed');
        throw classifyDbError(error, 'delete credential');
      }
    },
  );

  // ── POST /v1/credentials/:providerId/validate ──────────────────────────
  // Live key check against the provider (cheap authenticated read). Updates
  // the stored status so readiness surfaces reflect the outcome immediately.
  app.post(
    '/:providerId/validate',
    {
      config: { authz: { resource: 'credential', action: 'write' } },
      schema: {
        tags: ['Credentials'],
        summary: 'Verify a stored provider key against the live provider',
        params: z.object({ providerId: ProviderIdSchema }),
        body: z.object({ scope: CredentialScopeSchema }),
        response: {
          200: z.object({
            verified: z.boolean(),
            status: z.enum(['active', 'error']),
            errorCode: z.string().nullable(),
            message: z.string().nullable(),
          }),
          403: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
          422: z.object({ error: z.string(), message: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = getDb(fastify);
      if (!db) throw new Error('Database not configured');

      const { providerId } = request.params;
      const { scope } = request.body;
      const userId = request.authUser?.userId;
      if (!userId) throw new Error('Authentication required');

      if (request.authUser?.isServicePrincipal) {
        reply.status(403).send({ error: 'Credentials can only be managed by human users' });
        return;
      }

      if (!isVerifiableProvider(providerId)) {
        reply.status(422).send({
          error: 'VERIFY_UNSUPPORTED',
          message: `Live verification is not available for ${providerId}.`,
        });
        return;
      }

      // Derive scopeId from context (same rules as PUT/DELETE)
      let scopeId: string;
      switch (scope) {
        case 'user':
          scopeId = userId as string;
          break;
        case 'space': {
          const space = await request.requireSpace();
          if (!space.isSpaceAdmin) {
            reply.status(403).send({ error: 'Space-scoped credentials require space admin role' });
            return;
          }
          scopeId = space.spaceId as string;
          break;
        }
        case 'tenant':
          if (!tenant.isAdmin) {
            reply
              .status(403)
              .send({ error: 'Tenant-scoped credentials require tenant admin role' });
            return;
          }
          scopeId = tenant.tenantId as string;
          break;
        default:
          reply.status(422).send({ error: 'BadScope', message: `Invalid scope: ${String(scope)}` });
          return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);
      const [row] = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select()
          .from(providerCredentials)
          .where(
            and(
              eq(providerCredentials.providerId, providerId),
              eq(providerCredentials.scope, scope),
              eq(providerCredentials.scopeId, scopeId),
            ),
          )
          .limit(1);
      })) as Array<typeof providerCredentials.$inferSelect>;
      if (!row?.encryptedSecrets) {
        reply.status(404).send({ error: 'Credential not found' });
        return;
      }

      let secrets: Record<string, string>;
      try {
        secrets = JSON.parse(await decryptCredentialAsync(row.encryptedSecrets)) as Record<
          string,
          string
        >;
      } catch (error) {
        reply.log.error({ err: error }, 'Credential decrypt failed during validation');
        reply.status(500).send({ error: 'Credential could not be decrypted' });
        return;
      }

      const outcome = await verifyProviderKey(
        providerId,
        secrets,
        (row.configJson ?? {}) as Record<string, string>,
      );
      if (!outcome.supported) {
        reply.status(422).send({
          error: 'VERIFY_UNSUPPORTED',
          message: `Live verification is not available for ${providerId}.`,
        });
        return;
      }

      const now = new Date();
      const status = outcome.ok ? 'active' : 'error';
      // Compare-and-set on updatedAt: the probe can take up to 10s, and a
      // concurrent PUT of a corrected key must not have its 'active' status
      // clobbered by a validation of the old secret.
      await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .update(providerCredentials)
          .set(
            outcome.ok
              ? { status, lastValidatedAt: now, lastErrorCode: null, updatedAt: now }
              : { status, lastErrorAt: now, lastErrorCode: outcome.errorCode, updatedAt: now },
          )
          .where(
            and(
              eq(providerCredentials.id, row.id),
              eq(providerCredentials.updatedAt, row.updatedAt),
            ),
          );
      });
      invalidateCredentialCache(fastify, tenant.tenantId as string);

      reply.send({
        verified: outcome.ok,
        status,
        errorCode: outcome.ok ? null : outcome.errorCode,
        message: outcome.ok ? null : outcome.message,
      });
    },
  );

  // ── GET /v1/credentials/status ─────────────────────────────────────────
  //
  // Preview credential resolution for a provider in the user's current context.
  // Shows which scope would win and what scopes have credentials available.

  app.get(
    '/status',
    {
      config: { authz: { resource: 'credential', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Credentials'],
        summary: 'Preview credential resolution for a provider',
        querystring: z.object({
          providerId: ProviderIdSchema,
        }),
        response: {
          200: CredentialStatusSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const { providerId } = request.query;
      if (!db) {
        reply.send(emptyResolutionPreview(providerId));
        return;
      }

      const previews = await previewCredentialResolution(db, {
        tenantId: tenant.tenantId,
        userId: request.authUser!.userId as string,
        spaceId: space.spaceId as string,
        providerIds: [providerId],
      });
      reply.send(previews.get(providerId) ?? emptyResolutionPreview(providerId));
    },
  );
};
