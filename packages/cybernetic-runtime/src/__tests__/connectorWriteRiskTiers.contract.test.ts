/**
 * Contract: a connector definition installed into a space from a bundle keeps
 * the connector catalog's write-risk tiers. The bundle carries the draft shape,
 * which cannot hold `writeRiskTier`; the write gate reads the tier from the
 * STORED row, so a tier lost between the catalog and `api_definitions` turns a
 * gated write (GitHub's merge) into an unattended one. Each case runs the
 * bundle's own definition through the real draft writer and reads back the
 * `definition_json` it persists.
 */
import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  CONNECTOR_CATALOG,
  STORE_CATALOG,
  getConnectorDefinitionByApiId,
  listSkillBundles,
} from '@aflow/platform-artifacts';
import type { ApiDefinitionDraft, ApiEndpoint, BundledApiDefinition } from '@aflow/schemas';
import {
  type ConflictPolicy,
  overlayConnectorWriteRiskTiers,
  writeApiDefinitionDraft,
} from '../stagedChange/apiWriteHelpers.js';

const SPACE_ID = '00000000-0000-0000-0000-000000000001';
const dialect = new PgDialect();

/** Run one draft write against a one-row fake `api_definitions` table. */
async function storedEndpointsAfterWrite(opts: {
  apiId: string;
  draft: ApiDefinitionDraft;
  conflictPolicy: ConflictPolicy;
  existing?: Record<string, unknown>;
}): Promise<ApiEndpoint[]> {
  let row = opts.existing;
  const tx = {
    execute: async (query: SQL): Promise<unknown[]> => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      if (text.includes('SELECT definition_json FROM api_definitions')) {
        return row ? [{ definition_json: row }] : [];
      }
      if (text.includes('INSERT INTO api_definitions')) {
        if (row && !text.includes('DO UPDATE')) return [];
        row = JSON.parse(params[3] as string) as Record<string, unknown>;
        return [{ api_id: opts.apiId }];
      }
      throw new Error(`unhandled SQL: ${text}`);
    },
  };
  await writeApiDefinitionDraft({
    apiId: opts.apiId,
    draft: opts.draft,
    spaceId: SPACE_ID,
    conflictPolicy: opts.conflictPolicy,
    tx: tx as never,
  });
  if (!row) throw new Error('the write stored no row');
  return row['endpoints'] as ApiEndpoint[];
}

function bundledConnectorDefinitions(): Array<{ source: string; bundled: BundledApiDefinition }> {
  const out: Array<{ source: string; bundled: BundledApiDefinition }> = [];
  for (const bundle of listSkillBundles({ includeHidden: true })) {
    for (const bundled of bundle.apiDefinitions) {
      out.push({ source: `skill bundle ${bundle.bundleId}`, bundled });
    }
  }
  for (const entry of STORE_CATALOG) {
    if (entry.kind !== 'bundle') continue;
    for (const bundled of entry.payload.apiDefinitions) {
      out.push({ source: `store listing ${entry.catalogId}`, bundled });
    }
  }
  return out.filter(({ bundled }) => getConnectorDefinitionByApiId(bundled.apiId) !== null);
}

function expectCatalogTiers(apiId: string, stored: readonly ApiEndpoint[]): void {
  const connector = getConnectorDefinitionByApiId(apiId)!;
  const storedById = new Map(stored.map((ep) => [ep.endpointId, ep]));
  const lost = connector.endpoints
    .filter((ep) => ep.writeRiskTier !== undefined && storedById.has(ep.endpointId))
    .filter((ep) => storedById.get(ep.endpointId)?.writeRiskTier !== ep.writeRiskTier)
    .map(
      (ep) =>
        `${ep.endpointId}: catalog ${ep.writeRiskTier}, stored ${
          storedById.get(ep.endpointId)?.writeRiskTier ?? 'none'
        }`,
    );
  expect(lost, `"${apiId}" endpoints lost their catalog tier`).toEqual([]);
}

describe('a bundled connector definition keeps the catalog write-risk tiers', () => {
  const cases = bundledConnectorDefinitions();

  it('covers the GitHub definition the coding bundles ship', () => {
    expect(cases.some(({ bundled }) => bundled.apiId === 'github')).toBe(true);
  });

  for (const { source, bundled } of cases) {
    for (const conflictPolicy of ['skip', 'fail', 'overwrite'] as const) {
      it(`${source} / ${bundled.apiId} — fresh ${conflictPolicy} write`, async () => {
        const stored = await storedEndpointsAfterWrite({
          apiId: bundled.apiId,
          draft: bundled.definition,
          conflictPolicy,
        });
        expectCatalogTiers(bundled.apiId, stored);
      });
    }
  }
});

describe('an owned Store update repairs a tier-less stored row', () => {
  const github = bundledConnectorDefinitions().find(({ bundled }) => bundled.apiId === 'github')
    ?.bundled as BundledApiDefinition;

  it('overwrites the row with mergePullRequest gated at medium', async () => {
    const connector = getConnectorDefinitionByApiId('github')!;
    const tierless = {
      ...connector,
      endpoints: connector.endpoints.map(({ writeRiskTier: _dropped, ...ep }) => ep),
    };
    const stored = await storedEndpointsAfterWrite({
      apiId: 'github',
      draft: github.definition,
      conflictPolicy: 'overwrite',
      existing: tierless,
    });
    expect(stored.find((ep) => ep.endpointId === 'mergePullRequest')?.writeRiskTier).toBe('medium');
    expectCatalogTiers('github', stored);
  });
});

describe('overlayConnectorWriteRiskTiers', () => {
  const merge = getConnectorDefinitionByApiId('github')!.endpoints.find(
    (ep) => ep.endpointId === 'mergePullRequest',
  )!;
  const { writeRiskTier: _tier, ...untiered } = merge;

  it('gives a same-operation endpoint the catalog tier', () => {
    const [ep] = overlayConnectorWriteRiskTiers('github', [untiered]);
    expect(ep?.writeRiskTier).toBe('medium');
  });

  it('leaves an endpoint that reuses the id for a different call untiered', () => {
    const [byMethod] = overlayConnectorWriteRiskTiers('github', [{ ...untiered, method: 'POST' }]);
    const [byPath] = overlayConnectorWriteRiskTiers('github', [
      { ...untiered, pathTemplate: '/elsewhere' },
    ]);
    expect(byMethod?.writeRiskTier).toBeUndefined();
    expect(byPath?.writeRiskTier).toBeUndefined();
  });

  it('leaves a definition no connector owns untouched', () => {
    const [ep] = overlayConnectorWriteRiskTiers('not-a-connector', [untiered]);
    expect(ep).toEqual(untiered);
  });

  it('resolves every connector by its apiId', () => {
    for (const entry of CONNECTOR_CATALOG) {
      expect(getConnectorDefinitionByApiId(entry.definition.apiId)).toBe(entry.definition);
    }
  });
});
