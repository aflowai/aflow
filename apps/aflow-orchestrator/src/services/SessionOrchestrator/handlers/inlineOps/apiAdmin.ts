import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';
import { and, eq } from 'drizzle-orm';
import type { OperationId, SuggestedEgressPolicy } from '@aflow/schemas';
import {
  normalizeBindingInput,
  resolveBaseUrl,
  ApiDefinitionSchema,
  BindingFulfillmentSchema,
  extractCredentialKeys,
} from '@aflow/schemas';
import type { ApiEndpoint, BindingFulfillment } from '@aflow/schemas';
import { buildMergedDefinitionJson } from './apiDefinitionMerge.js';
import { deriveApiCredentialStatus } from '../../helpers/integrationReader.js';
import { addStepResult, publishApiCatalogInvalidation } from '@aflow/redis';
import {
  assertBindingFulfillmentWritable,
  collectApiBindingHosts,
  collectApiDefinitionHosts,
} from '@aflow/cybernetic-runtime';
import { diffEndpointsById, handleImportOpenApi } from './apiAdminOpenApiImport.js';
import {
  classifyApiAdminError,
  enforceApiAdminHostPolicy,
  patchedDefinitionHostSource,
} from './apiAdminHostPolicy.js';
import { encodeInlineOpOutputRef } from './helpers.js';
import {
  getDatabase,
  withTenantSchema,
  createTenantContext,
  apiDefinitions,
  apiBindings,
  apiCredentials,
  oauthTokens,
} from '@aflow/database';
import type { InlineHandlerArgs } from './types.js';
import { requireSpaceId } from './spaceScope.js';

export async function handleApiAdminOpInline(args: InlineHandlerArgs): Promise<void> {
  const {
    redis,
    payloadStore,
    context,
    stepDef,
    stepExecutionId,
    idempotencyKey,
    resolvedInputRef,
    attempt,
    parentStepExecutionId,
  } = args;
  const startTime = Date.now();
  const operationId = stepDef.operation;
  const spaceId = requireSpaceId(context);

  try {
    let input: Record<string, unknown> = {};
    try {
      const data = await payloadStore.retrieve(resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      /* empty input */
    }

    const db = getDatabase();
    const tenantCtx = createTenantContext(context.tenantId);
    let outputData: Record<string, unknown>;

    switch (operationId) {
      case 'api.definition.upsert': {
        const apiId = input['apiId'] as string;
        const { sql } = await import('drizzle-orm');
        // Read-merge-validate-write in ONE transaction, serialized per definition
        // via an advisory xact lock — the merge is a read-modify-write, and a
        // stale prior under concurrent upserts would silently lose endpoints.
        const outcome = await withTenantSchema(db, tenantCtx, async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${spaceId}:${apiId}`}, 0))`,
          );
          const priorRows = await tx
            .select({ definitionJson: apiDefinitions.definitionJson })
            .from(apiDefinitions)
            .where(and(eq(apiDefinitions.apiId, apiId), eq(apiDefinitions.spaceId, spaceId)))
            .limit(1);
          const priorJson =
            priorRows.length > 0
              ? (priorRows[0]!.definitionJson as Record<string, unknown>)
              : undefined;
          const priorEndpoints =
            (priorJson?.['endpoints'] as Array<Record<string, unknown>> | undefined) ?? [];

          const definitionJson = buildMergedDefinitionJson(apiId, input, priorJson);
          const validation = ApiDefinitionSchema.safeParse(definitionJson);
          if (!validation.success) {
            throw new Error(
              `Invalid API definition: ${validation.error.issues
                .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
                .join('; ')}`,
            );
          }
          // Persist the validated/normalized definition (schema defaults applied)
          // rather than the raw input, so the stored row matches what the runtime reads.
          const def = validation.data;
          await enforceApiAdminHostPolicy({
            db,
            context,
            spaceId,
            hosts: collectApiDefinitionHosts(def),
            grantRefs: [{ artifactType: 'api_definition', artifactKey: def.apiId }],
          });
          await tx.execute(sql`
            INSERT INTO api_definitions (api_id, name, description, base_url, version, definition_json, tags, space_id)
            VALUES (
              ${def.apiId},
              ${def.name},
              ${def.description ?? null},
              ${def.baseUrl ?? null},
              ${def.version},
              ${JSON.stringify(def)}::jsonb,
              ${JSON.stringify(def.tags)}::jsonb,
              ${spaceId}::uuid
            )
            ON CONFLICT (api_id, space_id) DO UPDATE SET
              name = EXCLUDED.name, description = EXCLUDED.description,
              base_url = EXCLUDED.base_url, version = EXCLUDED.version,
              definition_json = EXCLUDED.definition_json, tags = EXCLUDED.tags,
              updated_at = NOW()
          `);
          return { def, created: priorJson === undefined, priorEndpoints };
        });
        publishApiCatalogInvalidation(redis, context.tenantId as string, spaceId, {
          kind: 'definition',
          apiId,
        });
        outputData = {
          apiId,
          status: outcome.created ? 'created' : 'updated',
          endpoints: diffEndpointsById(
            outcome.priorEndpoints as Array<{ endpointId: string }>,
            outcome.def.endpoints,
          ),
        };
        break;
      }

      case 'api.definition.patch': {
        const apiId = input['apiId'] as string;
        const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
          return tx
            .select()
            .from(apiDefinitions)
            .where(and(eq(apiDefinitions.apiId, apiId), eq(apiDefinitions.spaceId, spaceId)))
            .limit(1);
        });
        if (rows.length === 0) throw new Error(`API definition "${apiId}" not found`);
        const row = rows[0]!;
        const existingDef = row.definitionJson as Record<string, unknown>;

        const patchableFields = [
          'baseUrl',
          'name',
          'description',
          'auth',
          'tags',
          'defaultHeaders',
        ] as const;
        const updatedFields: string[] = [];
        const updatedDef = { ...existingDef };

        for (const field of patchableFields) {
          if (input[field] !== undefined) {
            updatedDef[field] = input[field];
            updatedFields.push(field);
          }
        }

        if (updatedFields.length === 0) {
          outputData = { apiId, status: 'updated' as const, updatedFields: [] };
          break;
        }

        await enforceApiAdminHostPolicy({
          db,
          context,
          spaceId,
          hosts: collectApiDefinitionHosts(patchedDefinitionHostSource(updatedDef)),
          grantRefs: [{ artifactType: 'api_definition', artifactKey: apiId }],
        });

        const { sql } = await import('drizzle-orm');
        await withTenantSchema(db, tenantCtx, async (tx) => {
          await tx.execute(sql`
            UPDATE api_definitions SET
              name = ${(updatedDef['name'] as string | undefined) ?? row.name},
              description = ${(input['description'] as string | undefined) !== undefined ? (input['description'] as string) : (row.description ?? null)},
              base_url = ${(updatedDef['baseUrl'] as string | undefined) ?? row.baseUrl},
              definition_json = ${JSON.stringify(updatedDef)}::jsonb,
              tags = ${JSON.stringify(
                ((updatedDef['tags'] ?? row.tags) as string[] | undefined) ?? [],
              )}::jsonb,
              updated_at = NOW()
            WHERE api_id = ${apiId} AND space_id = ${spaceId}::uuid
          `);
        });

        publishApiCatalogInvalidation(redis, context.tenantId as string, spaceId, {
          kind: 'definition',
          apiId,
        });
        outputData = { apiId, status: 'updated' as const, updatedFields };
        break;
      }

      case 'api.definition.delete': {
        const apiId = input['apiId'] as string;
        const { sql } = await import('drizzle-orm');
        await withTenantSchema(db, tenantCtx, async (tx) => {
          await tx.execute(
            sql`DELETE FROM api_definitions WHERE api_id = ${apiId} AND space_id = ${spaceId}::uuid`,
          );
          await tx.execute(
            sql`DELETE FROM api_bindings WHERE api_id = ${apiId} AND space_id = ${spaceId}::uuid`,
          );
        });
        publishApiCatalogInvalidation(redis, context.tenantId as string, spaceId, {
          kind: 'definition',
          apiId,
        });
        outputData = { apiId, deleted: true };
        break;
      }

      case 'api.definition.get': {
        const apiId = input['apiId'] as string;
        const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
          return tx
            .select()
            .from(apiDefinitions)
            .where(and(eq(apiDefinitions.apiId, apiId), eq(apiDefinitions.spaceId, spaceId)))
            .limit(1);
        });
        if (rows.length === 0) throw new Error(`API definition "${apiId}" not found`);
        const row = rows[0]!;
        const defJson = row.definitionJson as Record<string, unknown>;
        // Return the stored definition verbatim (read-modify-write safe against the
        // upsert merge), minus writeRiskTier (Plan 253: never exposed to agents).
        const endpoints = (
          (defJson['endpoints'] as Array<Record<string, unknown>> | undefined) ?? []
        ).map(({ writeRiskTier: _writeRiskTier, ...ep }) => ep);
        outputData = {
          ...defJson,
          apiId: row.apiId,
          name: row.name,
          ...(row.description ? { description: row.description } : {}),
          endpoints,
          tags: (row.tags as string[] | undefined) ?? [],
          createdAt: new Date(row.createdAt).toISOString(),
          updatedAt: new Date(row.updatedAt).toISOString(),
        };
        break;
      }

      case 'api.binding.upsert': {
        const bindingId = input['bindingId'] as string;
        const apiIdForBinding = input['apiId'] as string;
        const { sql } = await import('drizzle-orm');
        const scope = input['scope'] as Record<string, unknown>;
        scope['tenantId'] = context.tenantId as string;
        scope['spaceId'] = spaceId;

        // Look up definition for baseUrl + baseUrlTemplate + suggestedEgressPolicy + callMode.
        let definitionBaseUrl: string | undefined;
        let definitionBaseUrlTemplate: string | undefined;
        let suggestedEgressPolicy: Record<string, unknown> | undefined;
        let definitionCallMode: string | undefined;
        let definitionEndpoints: ApiEndpoint[] | undefined;
        try {
          const defRows = await withTenantSchema(db, tenantCtx, async (tx) => {
            return tx
              .select({
                baseUrl: apiDefinitions.baseUrl,
                definitionJson: apiDefinitions.definitionJson,
              })
              .from(apiDefinitions)
              .where(
                and(eq(apiDefinitions.apiId, apiIdForBinding), eq(apiDefinitions.spaceId, spaceId)),
              )
              .limit(1);
          });
          if (defRows.length > 0) {
            definitionBaseUrl = defRows[0]!.baseUrl ?? undefined;
            const defJson = defRows[0]!.definitionJson as Record<string, unknown> | null;
            if (defJson?.['suggestedEgressPolicy']) {
              suggestedEgressPolicy = defJson['suggestedEgressPolicy'] as Record<string, unknown>;
            }
            definitionCallMode = defJson?.['callMode'] as string | undefined;
            definitionBaseUrlTemplate = defJson?.['baseUrlTemplate'] as string | undefined;
            definitionEndpoints = (defJson?.['endpoints'] as ApiEndpoint[] | undefined) ?? [];
          }
        } catch {
          // Definition table may not exist yet.
        }

        // A direct_url binding never attaches credentials at call time (the
        // executor ignores binding auth in direct-URL mode), so a non-none auth
        // profile is a false expectation — reject it.
        const incomingAuthType = (input['auth'] as Record<string, unknown> | undefined)?.['type'];
        if (
          definitionCallMode === 'direct_url' &&
          incomingAuthType &&
          incomingAuthType !== 'none'
        ) {
          const incomingAuthTypeLabel =
            typeof incomingAuthType === 'string'
              ? incomingAuthType
              : JSON.stringify(incomingAuthType);
          throw new Error(
            `Binding "${bindingId}" targets direct_url definition "${apiIdForBinding}" but declares auth type "${incomingAuthTypeLabel}". A direct_url binding must use auth type "none" — direct-URL mode never sends binding credentials.`,
          );
        }

        // Load the binding's stored auth + egress so a partial upsert preserves
        // both — the preserve-on-omit invariants live in normalizeBindingInput.
        let existingEgressPolicy: Record<string, unknown> | undefined;
        let existingAuth: Record<string, unknown> | undefined;
        let existingFulfillment: BindingFulfillment | undefined;
        let bindingExists = false;
        try {
          const bindingRows = await withTenantSchema(db, tenantCtx, async (tx) => {
            return tx
              .select({
                egressPolicyJson: apiBindings.egressPolicyJson,
                authJson: apiBindings.authJson,
                fulfillmentMode: apiBindings.fulfillmentMode,
                simulationId: apiBindings.simulationId,
              })
              .from(apiBindings)
              .where(and(eq(apiBindings.bindingId, bindingId), eq(apiBindings.spaceId, spaceId)))
              .limit(1);
          });
          if (bindingRows.length > 0) {
            bindingExists = true;
            existingEgressPolicy =
              (bindingRows[0]!.egressPolicyJson as Record<string, unknown> | null) ?? undefined;
            existingAuth =
              (bindingRows[0]!.authJson as Record<string, unknown> | null) ?? undefined;
            const storedSimulationId = bindingRows[0]!.simulationId;
            existingFulfillment =
              bindingRows[0]!.fulfillmentMode === 'simulated' && storedSimulationId !== null
                ? { mode: 'simulated', simulationId: storedSimulationId }
                : { mode: 'live' };
          }
        } catch {
          // Binding table may not exist yet.
        }

        const { auth, egressPolicy } = normalizeBindingInput({
          rawAuth: input['auth'] as Record<string, unknown> | undefined,
          rawEgressPolicy: input['egressPolicy'] as Record<string, unknown> | undefined,
          definitionBaseUrl,
          suggestedEgressPolicy: suggestedEgressPolicy as SuggestedEgressPolicy | undefined,
          existingEgressPolicy,
          existingAuth,
          definitionBaseUrlTemplate,
        });

        // Re-check the direct_url invariant on the EFFECTIVE auth — preserve-on-omit
        // can carry a stored non-none profile past the incoming-auth guard above
        // (e.g. repointing a bearer binding onto a direct_url definition).
        if (definitionCallMode === 'direct_url' && auth.type !== 'none') {
          throw new Error(
            `Binding "${bindingId}" targets direct_url definition "${apiIdForBinding}" but its ` +
              `effective auth type is "${auth.type}"` +
              (incomingAuthType ? '' : ' (preserved from the stored profile)') +
              '. A direct_url binding must use auth type "none" — pass auth: { type: "none" } explicitly.',
          );
        }

        await enforceApiAdminHostPolicy({
          db,
          context,
          spaceId,
          hosts: collectApiBindingHosts({
            auth: auth as unknown as Record<string, unknown>,
            egressPolicy,
          }),
          grantRefs: [
            { artifactType: 'api_binding', artifactKey: bindingId },
            { artifactType: 'api_definition', artifactKey: apiIdForBinding },
          ],
        });

        // Preserve-on-omit, for the same reason auth and egress preserve: an
        // unrelated update must never silently flip a simulated binding live,
        // which would point the agent's next call at a real host.
        const fulfillment: BindingFulfillment = ((): BindingFulfillment => {
          const raw = input['fulfillment'];
          if (raw === undefined) return existingFulfillment ?? { mode: 'live' };
          const parsed = BindingFulfillmentSchema.safeParse(raw);
          if (!parsed.success) {
            throw new Error(
              `Invalid fulfillment for binding "${bindingId}": ${parsed.error.issues
                .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
                .join('; ')}`,
            );
          }
          return parsed.data;
        })();

        await assertBindingFulfillmentWritable({
          db,
          tenantCtx,
          spaceId,
          bindingId,
          apiId: apiIdForBinding,
          fulfillment,
          definition:
            definitionEndpoints === undefined
              ? undefined
              : {
                  apiId: apiIdForBinding,
                  callMode: definitionCallMode === 'direct_url' ? 'direct_url' : 'endpoint',
                  endpoints: definitionEndpoints,
                },
        });

        // Omitting variableValues on an update preserves the stored values — a
        // partial/credential-only upsert must never silently NULL them (mirrors
        // the egress preserve-on-omit invariant). The COALESCE in ON CONFLICT
        // keeps the existing column when EXCLUDED is NULL.
        const variableValuesJson = input['variableValues']
          ? JSON.stringify(input['variableValues'])
          : null;

        await withTenantSchema(db, tenantCtx, async (tx) => {
          await tx.execute(sql`
            INSERT INTO api_bindings (binding_id, api_id, name, description, scope_json, auth_json, egress_policy_json, variable_values_json, fulfillment_mode, simulation_id, enabled, space_id)
            VALUES (
              ${bindingId},
              ${apiIdForBinding},
              ${input['name'] as string},
              ${(input['description'] as string | undefined) ?? null},
              ${JSON.stringify(scope)}::jsonb,
              ${JSON.stringify(auth)}::jsonb,
              ${JSON.stringify(egressPolicy)}::jsonb,
              ${variableValuesJson}::jsonb,
              ${fulfillment.mode},
              ${fulfillment.mode === 'simulated' ? fulfillment.simulationId : null},
              ${((input['enabled'] as boolean | undefined) ?? true) ? 1 : 0},
              ${spaceId}::uuid
            )
            ON CONFLICT (binding_id, space_id) DO UPDATE SET
              api_id = EXCLUDED.api_id, name = EXCLUDED.name,
              description = EXCLUDED.description, scope_json = EXCLUDED.scope_json,
              auth_json = EXCLUDED.auth_json, egress_policy_json = EXCLUDED.egress_policy_json,
              variable_values_json = COALESCE(EXCLUDED.variable_values_json, api_bindings.variable_values_json),
              fulfillment_mode = EXCLUDED.fulfillment_mode, simulation_id = EXCLUDED.simulation_id,
              enabled = EXCLUDED.enabled, updated_at = NOW()
          `);
        });
        publishApiCatalogInvalidation(redis, context.tenantId as string, spaceId, {
          kind: 'binding',
          apiId: apiIdForBinding,
        });

        const storedAuthJson = auth as unknown as Record<string, unknown>;
        let storedCredentialKeys = new Set<string>();
        try {
          const credRows = await withTenantSchema(db, tenantCtx, async (tx) =>
            tx
              .select({ credentialKey: apiCredentials.credentialKey })
              .from(apiCredentials)
              .where(eq(apiCredentials.spaceId, spaceId)),
          );
          storedCredentialKeys = new Set(credRows.map((c) => c.credentialKey));
        } catch {
          // Credentials table may be missing in tests.
        }
        let oauthToken: { expiresAt: Date; hasRefresh: boolean } | undefined;
        if (auth.type === 'oauth2_authorization_code') {
          try {
            const tokenRows = await withTenantSchema(db, tenantCtx, async (tx) =>
              tx
                .select({
                  expiresAt: oauthTokens.expiresAt,
                  refreshTokenEnc: oauthTokens.refreshTokenEnc,
                })
                .from(oauthTokens)
                .where(
                  and(
                    eq(oauthTokens.integrationKind, 'api'),
                    eq(oauthTokens.resourceKey, apiIdForBinding),
                  ),
                )
                .limit(1),
            );
            if (tokenRows.length > 0) {
              oauthToken = {
                expiresAt: tokenRows[0]!.expiresAt,
                hasRefresh: tokenRows[0]!.refreshTokenEnc !== null,
              };
            }
          } catch {
            // Token table may be missing in tests.
          }
        }
        outputData = {
          bindingId,
          status: bindingExists ? 'updated' : 'created',
          authType: auth.type,
          credentialKeys: extractCredentialKeys(storedAuthJson),
          credentialStatus: deriveApiCredentialStatus(
            auth.type,
            storedAuthJson,
            storedCredentialKeys,
            oauthToken,
            fulfillment,
          ),
          fulfillment,
        };
        break;
      }

      case 'api.binding.delete': {
        const bindingId = input['bindingId'] as string;
        const { sql } = await import('drizzle-orm');
        await withTenantSchema(db, tenantCtx, async (tx) => {
          await tx.execute(
            sql`DELETE FROM api_bindings WHERE binding_id = ${bindingId} AND space_id = ${spaceId}::uuid`,
          );
        });
        publishApiCatalogInvalidation(redis, context.tenantId as string, spaceId, {
          kind: 'binding',
        });
        outputData = { bindingId, deleted: true };
        break;
      }

      case 'api.binding.get': {
        const bindingId = input['bindingId'] as string;
        let rows = await withTenantSchema(db, tenantCtx, async (tx) => {
          return tx
            .select()
            .from(apiBindings)
            .where(and(eq(apiBindings.bindingId, bindingId), eq(apiBindings.spaceId, spaceId)))
            .limit(1);
        });
        // Fallback: if not found by bindingId, try interpreting it as an apiId
        if (rows.length === 0) {
          rows = await withTenantSchema(db, tenantCtx, async (tx) => {
            return tx
              .select()
              .from(apiBindings)
              .where(and(eq(apiBindings.apiId, bindingId), eq(apiBindings.spaceId, spaceId)))
              .limit(1);
          });
        }
        rows = rows.filter((row) => {
          const scope = row.scopeJson as Record<string, unknown>;
          return (scope['spaceId'] as string | undefined) === spaceId;
        });
        if (rows.length === 0) {
          throw new Error(
            `API binding "${bindingId}" not found in this space. ` +
              `Binding IDs typically follow the convention "{apiId}-default" (e.g., "${bindingId}-default"). ` +
              'Use api.binding.list to see all available bindings.',
          );
        }
        const row = rows[0]!;
        const authJson = row.authJson as Record<string, unknown>;
        outputData = {
          bindingId: row.bindingId,
          apiId: row.apiId,
          name: row.name,
          ...(row.description ? { description: row.description } : {}),
          scope: row.scopeJson as Record<string, unknown>,
          auth: authJson,
          credentialKeys: extractCredentialKeys(authJson),
          egressPolicy: row.egressPolicyJson as Record<string, unknown>,
          enabled: row.enabled === 1,
          createdAt: new Date(row.createdAt).toISOString(),
          updatedAt: new Date(row.updatedAt).toISOString(),
        };
        break;
      }

      case 'api.binding.list': {
        const filterApiId = input['apiId'] as string | undefined;
        const allRows = await withTenantSchema(db, tenantCtx, async (tx) => {
          if (filterApiId) {
            return tx
              .select()
              .from(apiBindings)
              .where(and(eq(apiBindings.apiId, filterApiId), eq(apiBindings.spaceId, spaceId)));
          }
          return tx.select().from(apiBindings).where(eq(apiBindings.spaceId, spaceId));
        });
        const rows = allRows.filter((row) => {
          const scope = row.scopeJson as Record<string, unknown>;
          const scopeSpaceId = scope['spaceId'] as string | undefined;
          return scopeSpaceId === spaceId;
        });
        const bindings = rows.map((row) => {
          const authJson = row.authJson as Record<string, unknown>;
          return {
            bindingId: row.bindingId,
            apiId: row.apiId,
            name: row.name,
            ...(row.description ? { description: row.description } : {}),
            scope: row.scopeJson as Record<string, unknown>,
            auth: authJson,
            credentialKeys: extractCredentialKeys(authJson),
            egressPolicy: row.egressPolicyJson as Record<string, unknown>,
            enabled: row.enabled === 1,
            createdAt: new Date(row.createdAt).toISOString(),
            updatedAt: new Date(row.updatedAt).toISOString(),
          };
        });
        outputData = { bindings, count: bindings.length };
        break;
      }

      case 'api.definition.import_openapi': {
        outputData = await handleImportOpenApi(db, tenantCtx, redis, context, input);
        break;
      }

      case 'api.binding.test': {
        const apiId = input['apiId'] as string;
        const endpointId = input['endpointId'] as string | undefined;

        const checks = {
          definitionFound: false,
          endpointFound: false,
          bindingResolved: false,
          credentialConfigured: false,
          egressAllowed: false,
        };

        // 1. Check definition exists
        const defRows = await withTenantSchema(db, tenantCtx, async (tx) => {
          return tx
            .select()
            .from(apiDefinitions)
            .where(and(eq(apiDefinitions.apiId, apiId), eq(apiDefinitions.spaceId, spaceId)))
            .limit(1);
        });
        if (defRows.length === 0) {
          outputData = {
            status: 'error' as const,
            checks,
            error: `API definition "${apiId}" not found. Create it first with api.definition.upsert.`,
          };
          break;
        }
        checks.definitionFound = true;
        const defRow = defRows[0]!;
        const defJson = defRow.definitionJson as Record<string, unknown>;
        const endpoints = (defJson['endpoints'] ?? []) as Array<{
          endpointId: string;
          pathTemplate: string;
          method: string;
        }>;

        // 2. Check endpoint exists
        const targetEndpoint = endpointId
          ? endpoints.find((e) => e.endpointId === endpointId)
          : endpoints[0];
        if (!targetEndpoint) {
          outputData = {
            status: 'error' as const,
            checks,
            error: endpointId
              ? `Endpoint "${endpointId}" not found in API "${apiId}". Available: ${endpoints.map((e) => e.endpointId).join(', ')}`
              : `API "${apiId}" has no endpoints defined.`,
          };
          break;
        }
        checks.endpointFound = true;

        const bindingRows = await withTenantSchema(db, tenantCtx, async (tx) => {
          return tx
            .select()
            .from(apiBindings)
            .where(and(eq(apiBindings.apiId, apiId), eq(apiBindings.spaceId, spaceId)));
        });
        const binding = bindingRows.find(
          (b) => (b.scopeJson as Record<string, unknown>)['spaceId'] === spaceId,
        );
        if (!binding) {
          outputData = {
            status: 'error' as const,
            checks,
            error: `No binding found for API "${apiId}" in this space. Create one with api.binding.upsert.`,
          };
          break;
        }
        checks.bindingResolved = true;

        // 4. Check credential keys are present
        const authJson = binding.authJson as Record<string, unknown>;
        const credKeys = extractCredentialKeys(authJson);
        if (credKeys.length > 0) {
          // Check if any credentials are stored (we can't decrypt here, just check existence)
          const { apiCredentials } = await import('@aflow/database');
          const { inArray } = await import('drizzle-orm');
          const credRows = await withTenantSchema(db, tenantCtx, async (tx) => {
            return tx
              .select({ credentialKey: apiCredentials.credentialKey })
              .from(apiCredentials)
              .where(inArray(apiCredentials.credentialKey, credKeys));
          });
          const storedKeys = new Set(credRows.map((r) => r.credentialKey));
          const missingKeys = credKeys.filter((k) => !storedKeys.has(k));
          if (missingKeys.length > 0) {
            outputData = {
              status: 'error' as const,
              checks,
              error: `Missing credential value(s): ${missingKeys.join(', ')}. Add them at the Integrations page.`,
            };
            break;
          }
        }
        checks.credentialConfigured = true;

        // 5. Check egress policy
        const egressPolicy = binding.egressPolicyJson as Record<string, unknown>;
        const allowedHosts = (egressPolicy['allowedHosts'] ?? []) as string[];
        // Resolve the effective base URL: a baseUrlTemplate definition substitutes
        // the binding's variableValues (e.g. {domain}); a fixed baseUrl is returned
        // unchanged. Throws a teaching error naming an unfilled required variable.
        let baseUrl: string;
        try {
          baseUrl = resolveBaseUrl(
            {
              ...(defJson['baseUrl'] !== undefined
                ? { baseUrl: defJson['baseUrl'] as string }
                : {}),
              ...(defJson['baseUrlTemplate'] !== undefined
                ? { baseUrlTemplate: defJson['baseUrlTemplate'] as string }
                : {}),
            },
            (binding.variableValuesJson as Record<string, string> | null) ?? undefined,
          );
        } catch (err) {
          outputData = {
            status: 'error' as const,
            checks,
            error:
              err instanceof Error ? err.message : `Failed to resolve base URL for "${apiId}".`,
          };
          break;
        }
        let resolvedUrl = '';
        try {
          const url = new URL(
            targetEndpoint.pathTemplate,
            baseUrl.endsWith('/') ? baseUrl : baseUrl + '/',
          );
          resolvedUrl = url.toString();
          const hostname = url.hostname;
          // Check host allowlist
          const hostAllowed =
            allowedHosts.length === 0 ||
            allowedHosts.some((pattern) => {
              if (pattern.startsWith('*.')) {
                const suffix = pattern.slice(1);
                return hostname === pattern.slice(2) || hostname.endsWith(suffix);
              }
              return hostname === pattern;
            });
          if (!hostAllowed) {
            outputData = {
              status: 'error' as const,
              checks,
              resolvedUrl,
              error: `Host "${hostname}" is not in the binding's allowedHosts: [${allowedHosts.join(', ')}]. Add it to the egressPolicy.`,
            };
            break;
          }
        } catch {
          outputData = {
            status: 'error' as const,
            checks,
            error: `Failed to resolve URL from baseUrl "${baseUrl}" and path "${targetEndpoint.pathTemplate}".`,
          };
          break;
        }
        checks.egressAllowed = true;

        outputData = {
          status: 'ok' as const,
          checks,
          resolvedUrl,
        };
        break;
      }

      default:
        throw new Error(`Unknown platform.api operation: ${operationId}`);
    }

    const outputRef = await encodeInlineOpOutputRef(
      payloadStore,
      context,
      stepExecutionId,
      attempt,
      outputData,
    );
    await addStepResult(redis, {
      messageVersion: 1,
      tenantId: context.tenantId,
      sessionId: context.runId,
      stepExecutionId,
      parentStepExecutionId: parentStepExecutionId ?? null,
      stepId: stepDef.stepId,
      stepType: stepDef.stepType,
      operationId: operationId as OperationId,
      attempt,
      idempotencyKey,
      status: 'SUCCEEDED',
      outputRef,
      resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });

    getOrchestratorLogger().debug(`[SessionOrchestrator] ${operationId} executed inline`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const classified = classifyApiAdminError(err, message);
    const errorData = {
      code: classified.code,
      message,
      classification: classified.classification,
      retryable: false,
      timestamp: new Date().toISOString(),
      ...(classified.details !== undefined ? { details: classified.details } : {}),
    };
    const errorRef = `inline:${Buffer.from(JSON.stringify(errorData)).toString('base64')}`;

    await addStepResult(redis, {
      messageVersion: 1,
      tenantId: context.tenantId,
      sessionId: context.runId,
      stepExecutionId,
      parentStepExecutionId: parentStepExecutionId ?? null,
      stepId: stepDef.stepId,
      stepType: stepDef.stepType,
      operationId: operationId as OperationId,
      attempt,
      idempotencyKey,
      status: 'FAILED',
      errorRef,
      error: errorData,
      resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });
  }
}
