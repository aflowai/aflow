import type { Redis } from 'ioredis';
import { and, eq } from 'drizzle-orm';
import { ApiDefinitionSchema } from '@aflow/schemas';
import { publishApiCatalogInvalidation } from '@aflow/redis';
import { safeFetch, validateUrl } from '@aflow/network-safety';
import {
  collectApiDefinitionHosts,
  overlayPlaneOnlyEndpointFields,
} from '@aflow/cybernetic-runtime';
import { enforceApiAdminHostPolicy } from './apiAdminHostPolicy.js';
import {
  type getDatabase,
  withTenantSchema,
  type createTenantContext,
  apiDefinitions,
} from '@aflow/database';
import type { FlowExecutionContext } from '../../types.js';
import { requireSpaceId } from './spaceScope.js';

// ============================================================================
// Endpoint diff — shared by definition.upsert and import_openapi result echoes
// ============================================================================

// Stored endpoints come back from a jsonb column (Postgres re-orders object
// keys); resent endpoints are fresh Zod output in shape order. The equality
// check must be key-order-insensitive or every identical resend reads 'updated'.
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function diffEndpointsById(
  existing: ReadonlyArray<{ endpointId: string }>,
  next: ReadonlyArray<{ endpointId: string }>,
): { added: string[]; updated: string[]; removed: string[]; unchanged: number } {
  const existingMap = new Map(existing.map((e) => [e.endpointId, e]));
  const nextMap = new Map(next.map((e) => [e.endpointId, e]));

  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  let unchanged = 0;

  for (const [id, ep] of nextMap) {
    const old = existingMap.get(id);
    if (!old) {
      added.push(id);
    } else if (JSON.stringify(sortKeysDeep(old)) !== JSON.stringify(sortKeysDeep(ep))) {
      updated.push(id);
    } else {
      unchanged++;
    }
  }
  for (const id of existingMap.keys()) {
    if (!nextMap.has(id)) removed.push(id);
  }

  return { added, updated, removed, unchanged };
}

// ============================================================================
// OpenAPI Import Helper
// ============================================================================

interface OpenApiEndpoint {
  endpointId: string;
  name: string;
  description?: string;
  method: string;
  pathTemplate: string;
  params: Array<{
    name: string;
    location: string;
    required: boolean;
    description?: string;
    schema?: Record<string, unknown>;
  }>;
  tags: string[];
  responseSchemas?: Record<string, unknown>;
}

function parseOpenApiSpec(
  specJson: Record<string, unknown>,
  options?: {
    filterTags?: string[];
    filterOperationIds?: string[];
    endpointIdPrefix?: string;
  },
): { endpoints: OpenApiEndpoint[]; baseUrl: string; title: string; description?: string } {
  const info = specJson['info'] as Record<string, unknown> | undefined;
  const title = (info?.['title'] as string | undefined) ?? 'Untitled API';
  const description = info?.['description'] as string | undefined;

  const servers = specJson['servers'] as Array<Record<string, unknown>> | undefined;
  const baseUrl = (servers?.[0]?.['url'] as string | undefined) ?? 'https://api.example.com';

  const paths = specJson['paths'] as Record<string, Record<string, unknown>> | undefined;
  if (!paths) {
    return {
      endpoints: [],
      baseUrl,
      title,
      ...(description ? { description } : {}),
    };
  }

  const endpoints: OpenApiEndpoint[] = [];
  const prefix = options?.endpointIdPrefix ?? '';
  const filterTagSet = options?.filterTags ? new Set(options.filterTags) : null;
  const filterOpIdSet = options?.filterOperationIds ? new Set(options.filterOperationIds) : null;

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const operation = pathItem[method] as Record<string, unknown> | undefined;
      if (!operation) continue;

      const operationId = operation['operationId'] as string | undefined;
      const opTags = (operation['tags'] ?? []) as string[];
      const summary = (operation['summary'] ?? operation['description'] ?? '') as string;

      if (filterTagSet && !opTags.some((t) => filterTagSet.has(t))) continue;
      if (filterOpIdSet && operationId && !filterOpIdSet.has(operationId)) continue;

      const endpointId =
        prefix + (operationId ?? `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`);

      const parameters = (operation['parameters'] ?? pathItem['parameters'] ?? []) as Array<
        Record<string, unknown>
      >;

      const params: OpenApiEndpoint['params'] = parameters.map((p) => {
        // Swagger 2 declares the request body as a parameter with in:'body' and
        // an inline JSON Schema — map it to the canonical body param instead of
        // letting mapParamLocation default it onto the query string.
        if (p['in'] === 'body') {
          return {
            name: 'body',
            location: 'body',
            required: (p['required'] as boolean | undefined) ?? false,
            schema: (p['schema'] as Record<string, unknown> | undefined) ?? {
              type: 'object',
              additionalProperties: true,
            },
            ...(p['description'] ? { description: p['description'] as string } : {}),
          };
        }
        return {
          name: p['name'] as string,
          location: mapParamLocation(p['in'] as string),
          required: (p['required'] as boolean | undefined) ?? false,
          ...(p['description'] ? { description: p['description'] as string } : {}),
        };
      });

      const requestBody = operation['requestBody'] as Record<string, unknown> | undefined;
      if (requestBody) {
        const content = requestBody['content'] as Record<string, unknown> | undefined;
        if (content) {
          // ApiDefinitionSchema requires a schema on every body param — a spec
          // that declares content without one still yields a valid open contract.
          const mediaTypes = Object.keys(content);
          const preferred = (content['application/json'] ??
            (mediaTypes[0] !== undefined ? content[mediaTypes[0]] : undefined)) as
            Record<string, unknown> | undefined;
          const bodySchema = (preferred?.['schema'] as Record<string, unknown> | undefined) ?? {
            type: 'object',
            additionalProperties: true,
          };
          params.push({
            name: 'body',
            location: 'body',
            required: (requestBody['required'] as boolean | undefined) ?? false,
            schema: bodySchema,
            ...(requestBody['description']
              ? { description: requestBody['description'] as string }
              : {}),
          });
        }
      }

      endpoints.push({
        endpointId,
        name: summary || endpointId,
        ...(operation['description'] ? { description: operation['description'] as string } : {}),
        method: method.toUpperCase(),
        pathTemplate: path,
        params,
        tags: opTags,
      });
    }
  }

  return { endpoints, baseUrl, title, ...(description ? { description } : {}) };
}

function mapParamLocation(openApiIn: string): string {
  switch (openApiIn) {
    case 'path':
      return 'path';
    case 'query':
      return 'query';
    case 'header':
      return 'header';
    case 'cookie':
      return 'header';
    default:
      return 'query';
  }
}

export async function handleImportOpenApi(
  db: ReturnType<typeof getDatabase>,
  tenantCtx: ReturnType<typeof createTenantContext>,
  redis: Redis,
  context: FlowExecutionContext,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const spaceId = requireSpaceId(context);
  const apiId = input['apiId'] as string;
  const specUrl = input['specUrl'] as string | undefined;
  const specInline = input['specInline'] as string | undefined;
  const name = input['name'] as string | undefined;
  const description = input['description'] as string | undefined;
  const options = input['options'] as
    | {
        filterTags?: string[];
        filterOperationIds?: string[];
        endpointIdPrefix?: string;
        pruneAbsent?: boolean;
      }
    | undefined;
  const dryRun = (input['dryRun'] as boolean | undefined) ?? false;

  let specJson: Record<string, unknown>;

  if (specUrl) {
    const validatedSpecUrl = await validateUrl(specUrl, []);
    await enforceApiAdminHostPolicy({
      db,
      context,
      spaceId,
      hosts: [validatedSpecUrl.url.hostname],
      grantRefs: [{ artifactType: 'api_definition', artifactKey: apiId }],
    });
    const resp = await safeFetch(validatedSpecUrl.url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch OpenAPI spec from ${specUrl}: ${String(resp.status)} ${resp.statusText}`,
      );
    }
    specJson = (await resp.json()) as Record<string, unknown>;
  } else if (specInline) {
    specJson = JSON.parse(specInline) as Record<string, unknown>;
  } else {
    throw new Error('Provide exactly one of specUrl or specInline');
  }

  const parsed = parseOpenApiSpec(specJson, options);

  const existingRows = await withTenantSchema(db, tenantCtx, async (tx) => {
    return tx
      .select()
      .from(apiDefinitions)
      .where(and(eq(apiDefinitions.apiId, apiId), eq(apiDefinitions.spaceId, spaceId)))
      .limit(1);
  });

  const existingDef = existingRows[0];
  const existingEndpoints: OpenApiEndpoint[] = existingDef
    ? (((existingDef.definitionJson as Record<string, unknown>)['endpoints'] as
        OpenApiEndpoint[] | undefined) ?? [])
    : [];

  // An OpenAPI spec cannot carry plane-only fields (Plan 253 writeRiskTier,
  // curated transform metadata) — a re-import must not strip them from
  // endpoints it replaces. Overlay before diffing so an endpoint whose only
  // difference is the preserved plane fields reads unchanged.
  const importedEndpoints = overlayPlaneOnlyEndpointFields(
    existingEndpoints as unknown as Array<Record<string, unknown>>,
    parsed.endpoints as unknown as Array<Record<string, unknown>>,
  ) as unknown as OpenApiEndpoint[];

  const diff = diffEndpointsById(existingEndpoints, importedEndpoints);
  const { added, updated, unchanged } = diff;
  // Without pruneAbsent, endpoints absent from the spec are retained — not removed.
  const removed = options?.pruneAbsent ? diff.removed : [];

  let finalEndpoints: OpenApiEndpoint[];
  if (options?.pruneAbsent) {
    finalEndpoints = importedEndpoints;
  } else {
    const newIds = new Set(importedEndpoints.map((e) => e.endpointId));
    finalEndpoints = [
      ...importedEndpoints,
      ...existingEndpoints.filter((e) => !newIds.has(e.endpointId)),
    ];
  }

  const defName = name ?? existingDef?.name ?? parsed.title;
  const defDescription =
    description ?? (existingDef?.description || undefined) ?? parsed.description;
  const baseUrl = parsed.baseUrl;

  const definitionJson = {
    apiId,
    name: defName,
    ...(defDescription ? { description: defDescription } : {}),
    baseUrl,
    version: existingDef?.version ?? '1',
    endpoints: finalEndpoints,
    tags: existingDef?.tags ?? [],
  };

  // Import must never persist a definition the platform's own validator rejects —
  // the upsert merge revalidates stored endpoints, so an invalid import would make
  // the definition un-editable. dryRun validates too, so a preview reports it.
  const validation = ApiDefinitionSchema.safeParse(definitionJson);
  if (!validation.success) {
    throw new Error(
      `Invalid API definition after OpenAPI import: ${validation.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const def = validation.data;

  if (!dryRun) {
    await enforceApiAdminHostPolicy({
      db,
      context,
      spaceId,
      hosts: collectApiDefinitionHosts({ baseUrl }),
      grantRefs: [{ artifactType: 'api_definition', artifactKey: apiId }],
    });
    const { sql } = await import('drizzle-orm');
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.execute(sql`
        INSERT INTO api_definitions (api_id, name, description, base_url, version, definition_json, tags, space_id)
        VALUES (
          ${apiId},
          ${defName},
          ${defDescription ?? null},
          ${baseUrl},
          ${existingDef?.version ?? '1'},
          ${JSON.stringify(def)}::jsonb,
          ${JSON.stringify(def.tags)}::jsonb,
          ${spaceId}::uuid
        )
        ON CONFLICT (api_id, space_id) DO UPDATE SET
          name = EXCLUDED.name, description = EXCLUDED.description,
          base_url = EXCLUDED.base_url,
          definition_json = EXCLUDED.definition_json,
          updated_at = NOW()
      `);
    });

    publishApiCatalogInvalidation(redis, context.tenantId as string, spaceId, {
      kind: 'definition',
      apiId,
    });
  }

  return {
    apiId,
    totalEndpoints: def.endpoints.length,
    added,
    updated,
    removed,
    unchanged,
    baseUrl,
    ...(dryRun ? { dryRun: true } : {}),
  };
}
