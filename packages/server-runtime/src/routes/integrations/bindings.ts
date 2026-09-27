/**
 * API binding CRUD routes.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  apiDefinitions,
  apiBindings,
  type ApiBindingRow,
} from '@aflow/database';
import {
  normalizeBindingInput,
  ApiVariableValuesSchema,
  type SuggestedEgressPolicy,
} from '@aflow/schemas';
import { publishApiCatalogInvalidation } from '@aflow/redis';
import {
  assertBindingFulfillmentWritable,
  SimulatedBindingRejected,
} from '@aflow/cybernetic-runtime';
import {
  BindingFulfillmentSchema,
  type ApiEndpoint,
  type BindingFulfillment,
} from '@aflow/schemas';
import {
  collectApiBindingHosts,
  enforceIntegrationHostPolicy,
  extractCredentialKeys,
  checkOAuthClientRegistered,
} from '@aflow/cybernetic-runtime';
import {
  ApiBindingResponseSchema,
  IntegrationWriteErrorSchema,
  getDb,
  getRedis,
  integrationPolicyDenialPayload,
  mapBindingRow,
} from './shared.js';
import {
  RequestBindingScopeSchema,
  composeStoredBindingScope,
  statedBindingScope,
} from './bindingScope.js';

export function registerBindingRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/bindings',
    {
      config: { authz: { resource: 'api_config', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'List API bindings',
        querystring: z.object({
          apiId: z.string().optional(),
        }),
        response: {
          200: z.object({
            bindings: z.array(ApiBindingResponseSchema),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);

      if (!db) {
        reply.send({ bindings: [] });
        return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);
      const query = request.query as { apiId?: string };
      const rows = (await withTenantSchema(db, tenantContext, async (tx) => {
        if (query.apiId) {
          return tx
            .select()
            .from(apiBindings)
            .where(and(eq(apiBindings.apiId, query.apiId), eq(apiBindings.spaceId, space.spaceId)));
        }
        return tx.select().from(apiBindings).where(eq(apiBindings.spaceId, space.spaceId));
      })) as ApiBindingRow[];

      const bindings = rows.map((row) => {
        const authJson = (row.authJson ?? {}) as Record<string, unknown>;
        const credentialKeys = extractCredentialKeys(authJson);
        return mapBindingRow(row as Parameters<typeof mapBindingRow>[0], credentialKeys);
      });

      reply.send({ bindings });
    },
  );

  app.get(
    '/bindings/:bindingId',
    {
      config: { authz: { resource: 'api_config', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Get API binding detail',
        params: z.object({ bindingId: z.string() }),
        response: {
          200: z.object({ binding: ApiBindingResponseSchema }),
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
      let rows = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select()
          .from(apiBindings)
          .where(and(eq(apiBindings.bindingId, bindingId), eq(apiBindings.spaceId, space.spaceId)))
          .limit(1);
      })) as ApiBindingRow[];

      // Fallback: if not found by bindingId, try interpreting it as an apiId
      if (rows.length === 0) {
        rows = (await withTenantSchema(db, tenantContext, async (tx) => {
          return tx
            .select()
            .from(apiBindings)
            .where(and(eq(apiBindings.apiId, bindingId), eq(apiBindings.spaceId, space.spaceId)))
            .limit(1);
        })) as ApiBindingRow[];
      }

      if (rows.length === 0) {
        reply.code(404).send({
          error:
            `API binding "${bindingId}" not found. ` +
            `Binding IDs typically follow the convention "{apiId}-default" (e.g., "${bindingId}-default"). ` +
            'Use GET /bindings to list all available bindings.',
        });
        return;
      }

      const row = rows[0]!;
      const scopeJson = (row.scopeJson ?? {}) as Record<string, unknown>;
      const scopeSpaceId = scopeJson['spaceId'] as string | undefined;
      if (scopeSpaceId && scopeSpaceId !== (space.spaceId as string)) {
        reply.code(404).send({ error: `API binding "${bindingId}" not found` });
        return;
      }

      const authJson = (row.authJson ?? {}) as Record<string, unknown>;
      const credentialKeys = extractCredentialKeys(authJson);

      reply.send({
        binding: mapBindingRow(row as Parameters<typeof mapBindingRow>[0], credentialKeys),
      });
    },
  );

  app.post(
    '/bindings',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Create or update an API binding',
        body: z.object({
          bindingId: z.string().min(1).max(128),
          apiId: z.string().min(1).max(128),
          name: z.string().min(1).max(256),
          description: z.string().max(2000).optional(),
          // Composed below rather than accepted; `flowId` is the caller's to state.
          scope: RequestBindingScopeSchema,
          // Optional: omitting auth on an update preserves the stored auth profile;
          // providing the same type without credential-key fields inherits them.
          auth: z.record(z.unknown()).optional(),
          // Optional: omitting egress on an update preserves the stored allowlist.
          egressPolicy: z.record(z.unknown()).optional(),
          // NON-SECRET per-binding (space-scoped) config substituted into the
          // definition's baseUrlTemplate (e.g. { domain: "acme" }). NEVER secrets.
          // Host-safe keys/values validated here (and again at call time).
          variableValues: ApiVariableValuesSchema.optional(),
          // Omitting it on an update preserves the stored mode, for the same
          // reason auth and egress preserve: an unrelated edit must never
          // silently flip a simulated binding live and point the next call at
          // a real host.
          fulfillment: BindingFulfillmentSchema.optional(),
          enabled: z.boolean().default(true),
          // Create-intent: when true, refuse (409) rather than upsert if a
          // binding with this id already exists in the space — no silent clobber.
          expectAbsent: z.boolean().optional(),
        }),
        response: {
          200: z.object({ bindingId: z.string(), status: z.string() }),
          400: IntegrationWriteErrorSchema,
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const body = request.body;

      if (!db) throw new Error('Database not configured');

      const scopeIdentity = {
        tenantId: tenant.tenantId as string,
        spaceId: space.spaceId as string,
      };
      const scope = composeStoredBindingScope(body.scope, scopeIdentity);
      // Null when the request stated no scope, so the update below keeps the
      // narrowing already stored rather than replacing it with a space-wide one.
      const scopeStated = statedBindingScope(body.scope, scopeIdentity);

      const tenantContext = createTenantContext(tenant.tenantId);

      // Look up the definition's baseUrl + baseUrlTemplate + suggestedEgressPolicy + callMode.
      let definitionBaseUrl: string | undefined;
      let definitionBaseUrlTemplate: string | undefined;
      let suggestedEgressPolicy: SuggestedEgressPolicy | undefined;
      let definitionCallMode: string | undefined;
      let definitionEndpoints: ApiEndpoint[] | undefined;
      try {
        const defRows = await withTenantSchema(db, tenantContext, async (tx) => {
          return tx
            .select({
              baseUrl: apiDefinitions.baseUrl,
              definitionJson: apiDefinitions.definitionJson,
            })
            .from(apiDefinitions)
            .where(
              and(eq(apiDefinitions.apiId, body.apiId), eq(apiDefinitions.spaceId, space.spaceId)),
            )
            .limit(1);
        });
        if (defRows.length > 0) {
          definitionBaseUrl = defRows[0]?.baseUrl ?? undefined;
          const defJson = defRows[0]?.definitionJson as Record<string, unknown> | null;
          if (defJson?.['suggestedEgressPolicy']) {
            suggestedEgressPolicy = defJson['suggestedEgressPolicy'] as SuggestedEgressPolicy;
          }
          definitionCallMode = defJson?.['callMode'] as string | undefined;
          definitionBaseUrlTemplate = defJson?.['baseUrlTemplate'] as string | undefined;
          const rawEndpoints = defJson?.['endpoints'];
          if (Array.isArray(rawEndpoints)) definitionEndpoints = rawEndpoints as ApiEndpoint[];
        }
      } catch {
        // Definition table may not exist; proceed without auto-derivation.
      }

      // A direct_url binding never attaches credentials (direct-URL mode ignores
      // binding auth), so a non-none auth profile is a false expectation.
      const incomingAuthType = body.auth?.['type'];
      if (definitionCallMode === 'direct_url' && incomingAuthType && incomingAuthType !== 'none') {
        const incomingAuthTypeLabel =
          typeof incomingAuthType === 'string'
            ? incomingAuthType
            : JSON.stringify(incomingAuthType);
        reply.code(400).send({
          error: `Binding "${body.bindingId}" targets direct_url definition "${body.apiId}" but declares auth type "${incomingAuthTypeLabel}". A direct_url binding must use auth type "none".`,
        });
        return;
      }

      // Load the binding's stored auth + egress so a partial (e.g. credential-only)
      // upsert preserves both instead of rebuilding them.
      let existingEgressPolicy: Record<string, unknown> | undefined;
      let existingAuth: Record<string, unknown> | undefined;
      let existingFulfillment: BindingFulfillment | undefined;
      try {
        const bindingRows = await withTenantSchema(db, tenantContext, async (tx) => {
          return tx
            .select({
              egressPolicyJson: apiBindings.egressPolicyJson,
              authJson: apiBindings.authJson,
              fulfillmentMode: apiBindings.fulfillmentMode,
              simulationId: apiBindings.simulationId,
            })
            .from(apiBindings)
            .where(
              and(
                eq(apiBindings.bindingId, body.bindingId),
                eq(apiBindings.spaceId, space.spaceId),
              ),
            )
            .limit(1);
        });
        if (bindingRows.length > 0) {
          existingEgressPolicy =
            (bindingRows[0]?.egressPolicyJson as Record<string, unknown> | null) ?? undefined;
          existingAuth = (bindingRows[0]?.authJson as Record<string, unknown> | null) ?? undefined;
          const storedMode = bindingRows[0]?.fulfillmentMode;
          const storedSimulationId = bindingRows[0]?.simulationId;
          if (storedMode === 'simulated' && storedSimulationId) {
            existingFulfillment = { mode: 'simulated', simulationId: storedSimulationId };
          } else if (storedMode === 'live') {
            existingFulfillment = { mode: 'live' };
          }
        }
      } catch {
        // Binding table may not exist; proceed as a create.
      }

      const { auth, egressPolicy } = normalizeBindingInput({
        rawAuth: body.auth,
        rawEgressPolicy: body.egressPolicy,
        definitionBaseUrl,
        suggestedEgressPolicy,
        existingEgressPolicy,
        existingAuth,
        definitionBaseUrlTemplate,
      });

      // The effective value, and it is what gets validated AND written. Checking
      // only a supplied `fulfillment` would miss the case that actually breaks:
      // an upsert that omits it (so the stored simulated mode is preserved)
      // while replacing `apiId`, leaving a binding pointed at an API its
      // simulation does not target — valid at write, failing at execution.
      const effectiveFulfillment: BindingFulfillment = body.fulfillment ??
        existingFulfillment ?? { mode: 'live' };

      try {
        await assertBindingFulfillmentWritable({
          db,
          tenantCtx: tenantContext,
          spaceId: space.spaceId as string,
          bindingId: body.bindingId,
          apiId: body.apiId,
          fulfillment: effectiveFulfillment,
          definition:
            definitionEndpoints === undefined
              ? undefined
              : {
                  apiId: body.apiId,
                  callMode: definitionCallMode === 'direct_url' ? 'direct_url' : 'endpoint',
                  endpoints: definitionEndpoints,
                },
        });
      } catch (error) {
        if (error instanceof SimulatedBindingRejected) {
          reply.code(400).send({ error: error.message });
          return;
        }
        throw error;
      }

      // Re-check the direct_url invariant on the EFFECTIVE auth — preserve-on-omit
      // can carry a stored non-none profile past the incoming-auth guard above.
      if (definitionCallMode === 'direct_url' && auth.type !== 'none') {
        reply.code(400).send({
          error:
            `Binding "${body.bindingId}" targets direct_url definition "${body.apiId}" but its ` +
            `effective auth type is "${auth.type}"` +
            (incomingAuthType ? '' : ' (preserved from the stored profile)') +
            '. A direct_url binding must use auth type "none" — pass auth: { type: "none" } explicitly.',
        });
        return;
      }

      try {
        await enforceIntegrationHostPolicy({
          db,
          tenantId: tenant.tenantId as string,
          spaceId: space.spaceId as string,
          kind: 'api',
          hosts: collectApiBindingHosts({
            auth: auth as unknown as Record<string, unknown>,
            egressPolicy,
          }),
          grantRefs: [
            { artifactType: 'api_binding', artifactKey: body.bindingId },
            { artifactType: 'api_definition', artifactKey: body.apiId },
          ],
        });
      } catch (err) {
        const denial = integrationPolicyDenialPayload(err);
        if (denial) {
          reply.code(400).send(denial);
          return;
        }
        throw err;
      }

      // A 3-legged binding declaring a tenant/space client app must point at a
      // registered oauth_clients row — otherwise consent has no client_id (§10).
      if (auth.type === 'oauth2_authorization_code' && auth.clientScope !== 'platform') {
        const guardError = await withTenantSchema(db, tenantContext, async (tx) =>
          checkOAuthClientRegistered(tx, auth.clientScope, auth.issuerKey, {
            tenantId: tenant.tenantId as string,
            spaceId: space.spaceId as string,
          }),
        );
        if (guardError) {
          reply.code(400).send({ error: guardError });
          return;
        }
      }

      // Omitting variableValues on an update preserves the stored values — a
      // partial/credential-only upsert must never silently NULL them (mirrors
      // the egress preserve-on-omit invariant). The COALESCE in ON CONFLICT
      // keeps the existing column when EXCLUDED is NULL.
      const variableValuesJson = body.variableValues ? JSON.stringify(body.variableValues) : null;

      const fulfillmentMode = effectiveFulfillment.mode;
      const fulfillmentSimulationId =
        effectiveFulfillment.mode === 'simulated' ? effectiveFulfillment.simulationId : null;

      // A create (`expectAbsent`) must never clobber an existing binding. Branch the
      // conflict action atomically: DO NOTHING on create (a concurrent winner leaves
      // ours a no-op → 409 below), DO UPDATE on edit. A separate SELECT-then-write
      // would be a TOCTOU race; the single statement closes it.
      const conflictAction =
        body.expectAbsent === true
          ? sql`ON CONFLICT (binding_id, space_id) DO NOTHING`
          : sql`ON CONFLICT (binding_id, space_id) DO UPDATE SET
            api_id = EXCLUDED.api_id,
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            scope_json = COALESCE(${scopeStated === null ? null : JSON.stringify(scopeStated)}::jsonb, api_bindings.scope_json),
            auth_json = EXCLUDED.auth_json,
            egress_policy_json = EXCLUDED.egress_policy_json,
            variable_values_json = COALESCE(EXCLUDED.variable_values_json, api_bindings.variable_values_json),
            fulfillment_mode = ${fulfillmentMode},
            simulation_id = ${fulfillmentSimulationId},
            enabled = EXCLUDED.enabled,
            updated_at = NOW()`;

      const writeResult = await withTenantSchema(db, tenantContext, async (tx) => {
        return tx.execute(sql`
          INSERT INTO api_bindings (binding_id, api_id, name, description, scope_json, auth_json, egress_policy_json, variable_values_json, fulfillment_mode, simulation_id, enabled, space_id)
          VALUES (
            ${body.bindingId},
            ${body.apiId},
            ${body.name},
            ${body.description ?? null},
            ${JSON.stringify(scope)}::jsonb,
            ${JSON.stringify(auth)}::jsonb,
            ${JSON.stringify(egressPolicy)}::jsonb,
            ${variableValuesJson}::jsonb,
            ${fulfillmentMode},
            ${fulfillmentSimulationId},
            ${body.enabled ? 1 : 0},
            ${space.spaceId}::uuid
          )
          ${conflictAction}
          RETURNING binding_id
        `);
      });

      if (body.expectAbsent === true && (writeResult as unknown as unknown[]).length === 0) {
        reply.code(409).send({
          error: `A connection "${body.bindingId}" already exists in this space. Choose a different Connection ID.`,
        });
        return;
      }

      const redis = getRedis(fastify);
      if (redis) {
        publishApiCatalogInvalidation(redis, tenant.tenantId as string, space.spaceId, {
          kind: 'binding',
          apiId: body.apiId,
        });
      }

      reply.send({ bindingId: body.bindingId, status: 'ok' });
    },
  );

  app.delete(
    '/bindings/:bindingId',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Delete an API binding',
        params: z.object({ bindingId: z.string() }),
        response: {
          200: z.object({ status: z.string() }),
          404: z.object({ error: z.string() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const { bindingId } = request.params as { bindingId: string };

      if (!db) throw new Error('Database not configured');

      const tenantContext = createTenantContext(tenant.tenantId);

      const rows = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select()
          .from(apiBindings)
          .where(and(eq(apiBindings.bindingId, bindingId), eq(apiBindings.spaceId, space.spaceId)))
          .limit(1);
      })) as ApiBindingRow[];

      if (rows.length === 0) {
        reply.code(404).send({ error: `API binding "${bindingId}" not found` });
        return;
      }

      // Fail-closed (Plan 222): a coding repo resolves git + the GitHub API THROUGH
      // its connection, so deleting one that still backs a live repo would orphan it.
      // The NOT EXISTS guard + the DELETE are ONE statement (no count-then-delete
      // TOCTOU); a repo created concurrently is still caught at run time by the
      // executor's resolver (CONNECTION_MISSING).
      const deleted = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx.execute<{ binding_id: string }>(sql`
          DELETE FROM api_bindings
          WHERE binding_id = ${bindingId} AND space_id = ${space.spaceId}::uuid
            AND NOT EXISTS (
              SELECT 1 FROM repo_bindings
              WHERE connection_binding_id = ${bindingId}
                AND space_id = ${space.spaceId}::uuid
                AND status != 'archived'
            )
          RETURNING binding_id
        `);
      })) as unknown as Array<{ binding_id: string }>;
      if (deleted.length === 0) {
        reply.code(409).send({
          error:
            `Connection "${bindingId}" still backs a coding repository that resolves git + the ` +
            'GitHub API through it. Re-link or remove the repository before deleting this connection.',
        });
        return;
      }

      const redis = getRedis(fastify);
      if (redis) {
        publishApiCatalogInvalidation(redis, tenant.tenantId as string, space.spaceId, {
          kind: 'binding',
        });
      }

      reply.send({ status: 'deleted' });
    },
  );
}
