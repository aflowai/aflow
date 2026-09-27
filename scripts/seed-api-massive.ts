/**
 * Seed script: upsert Massive.com (Polygon.io) API definition + binding.
 *
 * IMPORTANT:
 * - No secrets are written to the database.
 * - Auth uses credentialKey references only.
 *
 * Dev credential fallback:
 * - Set env var MASSIVE_API_KEY (or change credentialKey below).
 *
 * Usage:
 *   dotenv -e .env -- npx tsx scripts/seed-api-massive.ts
 *
 * Required:
 *   DATABASE_URL
 *
 * Optional:
 *   TENANT_ID (default: a0000000-0000-0000-0000-000000000001)
 */
import 'dotenv/config';

import { eq, and } from 'drizzle-orm';
import type { ApiBinding, ApiDefinition } from '@aflow/schemas';
import {
  apiBindings,
  apiDefinitions,
  closeConnection,
  createTenantContext,
  getDatabase,
  spaces,
  withTenantSchema,
} from '@aflow/database';

const TENANT_ID = process.env.TENANT_ID ?? 'a0000000-0000-0000-0000-000000000001';

async function main() {
  const db = getDatabase();
  const tenant = createTenantContext(TENANT_ID as any);

  const definition: ApiDefinition = {
    apiId: 'massive',
    name: 'Massive Markets',
    description: 'Market data API (formerly Polygon.io). Seeded for dev testing.',
    baseUrl: 'https://api.massive.com',
    version: '1',
    endpoints: [
      {
        endpointId: 'open_close',
        name: 'Open/Close (v1)',
        description: 'Get the open, close and afterhours info for a ticker on a given date.',
        method: 'GET',
        pathTemplate: '/v1/open-close/{ticker}/{date}',
        params: [
          { name: 'ticker', location: 'path', required: true, description: 'Ticker symbol' },
          { name: 'date', location: 'path', required: true, description: 'Date (YYYY-MM-DD)' },
          { name: 'adjusted', location: 'query', required: false, description: 'Adjusted results' },
        ],
        tags: ['open-close'],
        examples: [
          {
            name: 'AAPL 2023-01-09',
            params: { ticker: 'AAPL', date: '2023-01-09', adjusted: true },
          },
        ],
      },
      {
        endpointId: 'reference_tickers',
        name: 'List tickers (v3)',
        description: 'Search/list tickers.',
        method: 'GET',
        pathTemplate: '/v3/reference/tickers',
        params: [
          {
            name: 'ticker',
            location: 'query',
            required: false,
            description: 'Filter by ticker prefix',
          },
          { name: 'limit', location: 'query', required: false, description: 'Page size' },
        ],
        tags: ['reference'],
      },
    ],
    defaultHeaders: {
      'User-Agent': 'phoenix-aflow-dev',
      Accept: 'application/json',
    },
    tags: ['massive', 'polygon', 'markets'],
    source: 'custom',
  };

  const binding: ApiBinding = {
    bindingId: 'massive-default',
    apiId: definition.apiId,
    name: 'Massive default binding (dev)',
    description:
      'Dev binding that resolves MASSIVE_API_KEY from the runtime credential resolver (env fallback).',
    scope: { tenantId: TENANT_ID },
    auth: {
      type: 'api_key',
      placement: 'query',
      queryParamName: 'apiKey',
      headerName: 'X-API-Key',
      credentialKey: 'MASSIVE_API_KEY',
    },
    egressPolicy: {
      allowedHosts: ['api.massive.com'],
      allowedMethods: ['GET'],
      maxRequestBodyBytes: 1_048_576,
      maxResponseBodyBytes: 10_485_760,
      timeoutMs: 30_000,
      maxRedirects: 0,
      allowCrossHostRedirects: false,
      retryPolicy: {
        maxRetries: 2,
        retryableStatusCodes: [429, 502, 503, 504],
        retryOnlyIdempotent: true,
        backoffBaseMs: 1000,
        backoffMaxMs: 30_000,
      },
    },
    enabled: true,
  };

  await withTenantSchema(db, tenant, async (tx) => {
    // Resolve the General space
    const spaceRows = await tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.slug, 'general'))
      .limit(1);
    const generalSpaceId = spaceRows[0]?.id;
    if (!generalSpaceId) throw new Error('No "general" space found');

    // Replace any prior seed with same IDs.
    await tx.delete(apiBindings).where(eq(apiBindings.bindingId, binding.bindingId));
    await tx
      .delete(apiDefinitions)
      .where(
        and(eq(apiDefinitions.apiId, definition.apiId), eq(apiDefinitions.spaceId, generalSpaceId)),
      );

    await tx.insert(apiDefinitions).values({
      apiId: definition.apiId,
      name: definition.name,
      description: definition.description ?? null,
      baseUrl: definition.baseUrl,
      version: definition.version,
      definitionJson: definition as any,
      tags: definition.tags ?? [],
      source: definition.source ?? 'custom',
      enabled: 1,
      spaceId: generalSpaceId,
    });

    await tx.insert(apiBindings).values({
      bindingId: binding.bindingId,
      apiId: binding.apiId,
      name: binding.name,
      description: binding.description ?? null,
      scopeJson: binding.scope as any,
      authJson: binding.auth as any,
      egressPolicyJson: binding.egressPolicy as any,
      enabled: binding.enabled ? 1 : 0,
    });
  });

  console.log(
    `Seeded API definition + binding: apiId=${definition.apiId} bindingId=${binding.bindingId}`,
  );
  await closeConnection();
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
