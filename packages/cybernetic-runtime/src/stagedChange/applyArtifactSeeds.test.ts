import { describe, it, expect, beforeEach } from 'vitest';
import { computeAppletDefinitionHash } from '@aflow/applet-runtime';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import { applyArtifactSeeds, renderContractHash } from './applyArtifactSeeds.js';
import { AppletDefinitionSchema, type BundleArtifactSeed } from '@aflow/schemas';

// ============================================================================
// Tiny in-memory tx mock
// ============================================================================

interface ArtifactRow {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  space_id: string;
  current_version: number;
  catalog_id: string;
  catalog_version: string;
  catalog_hash: string;
  tags: string[];
  bundle_artifact_key: string | null;
  updated_at: Date;
}
interface VersionRow {
  id: string;
  artifact_id: string;
  version: number;
  source_ref: string;
  compiled_ref: string | null;
  html_ref: string | null;
  content_hash: string;
  prompt: string;
  data_schema: unknown;
  validation_report: unknown;
  parent_version_id: string | null;
  sample_data: unknown;
  sample_data_payload_ref: string | null;
  applet_definition: unknown;
  definition_hash: string | null;
}
interface BindingRow {
  space_id: string;
  bundle_id: string;
  binding_id: string;
  artifact_id: string;
  bundle_artifact_key: string;
  enabled: boolean;
}

interface Store {
  artifacts: ArtifactRow[];
  versions: VersionRow[];
  bindings: BindingRow[];
}

function uuid(prefix: string, n: number): string {
  return `${prefix.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** The table mocks start as marker strings and become column-accessor Proxies
 *  carrying `__table` — resolve either form to the marker. */
function tableKey(table: unknown): string {
  if (typeof table === 'string') return table;
  const marker = (table as { __table?: unknown }).__table;
  return typeof marker === 'string' ? marker : 'unknown';
}

function makeTx(store: Store) {
  let artifactCounter = 0;
  let versionCounter = 0;
  return {
    // tx.select().from(table).where(predicate).limit(n) → Promise<rows[]>
    select() {
      return {
        from(table: unknown) {
          return {
            where(predicate: { __test_filter: (row: Record<string, unknown>) => boolean }) {
              const rows = (
                tableKey(table) === '__uiArtifacts'
                  ? store.artifacts
                  : tableKey(table) === '__uiArtifactVersions'
                    ? store.versions
                    : []
              ) as Record<string, unknown>[];
              return {
                limit(_n: number) {
                  return Promise.resolve(rows.filter((r) => predicate.__test_filter(r)));
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(row: Record<string, unknown>) {
          if (tableKey(table) === '__uiArtifacts') {
            artifactCounter += 1;
            const id = uuid('artifact', artifactCounter);
            const inserted: ArtifactRow = {
              id,
              name: String(row['name']),
              description: (row['description'] as string | null) ?? null,
              kind: String(row['kind']),
              space_id: String(row['spaceId']),
              current_version: Number(row['currentVersion']),
              catalog_id: String(row['catalogId']),
              catalog_version: String(row['catalogVersion']),
              catalog_hash: String(row['catalogHash']),
              tags: row['tags'] as string[],
              bundle_artifact_key: (row['bundleArtifactKey'] as string | null) ?? null,
              updated_at: new Date(),
            };
            store.artifacts.push(inserted);
            return {
              returning(_cols: unknown) {
                return Promise.resolve([{ id }]);
              },
            };
          }
          if (tableKey(table) === '__uiArtifactVersions') {
            versionCounter += 1;
            const id = uuid('version', versionCounter);
            const inserted: VersionRow = {
              id,
              artifact_id: String(row['artifactId']),
              version: Number(row['version']),
              source_ref: String(row['sourceRef']),
              compiled_ref: (row['compiledRef'] as string | null) ?? null,
              html_ref: (row['htmlRef'] as string | null) ?? null,
              content_hash: String(row['contentHash']),
              prompt: String(row['prompt']),
              data_schema: row['dataSchema'],
              validation_report: row['validationReport'] ?? null,
              parent_version_id: (row['parentVersionId'] as string | null) ?? null,
              sample_data: row['sampleData'],
              sample_data_payload_ref: (row['sampleDataPayloadRef'] as string | null) ?? null,
              applet_definition: row['appletDefinition'] ?? null,
              definition_hash: (row['definitionHash'] as string | null) ?? null,
            };
            store.versions.push(inserted);
            return Promise.resolve();
          }
          throw new Error(`Unknown insert table: ${tableKey(table)}`);
        },
      };
    },
    update(table: unknown) {
      return {
        set(patch: Record<string, unknown>) {
          return {
            where(predicate: { __test_filter: (row: Record<string, unknown>) => boolean }) {
              if (tableKey(table) === '__uiArtifacts') {
                for (const row of store.artifacts) {
                  if (predicate.__test_filter(row as unknown as Record<string, unknown>)) {
                    if (patch['name'] !== undefined) row.name = String(patch['name']);
                    if (patch['description'] !== undefined)
                      row.description = (patch['description'] as string | null) ?? null;
                    if (patch['kind'] !== undefined) row.kind = String(patch['kind']);
                    if (patch['currentVersion'] !== undefined)
                      row.current_version = Number(patch['currentVersion']);
                    if (patch['catalogId'] !== undefined)
                      row.catalog_id = String(patch['catalogId']);
                    if (patch['catalogVersion'] !== undefined)
                      row.catalog_version = String(patch['catalogVersion']);
                    if (patch['catalogHash'] !== undefined)
                      row.catalog_hash = String(patch['catalogHash']);
                    if (patch['tags'] !== undefined) row.tags = patch['tags'] as string[];
                    row.updated_at = new Date();
                  }
                }
                return Promise.resolve();
              }
              throw new Error(`Unknown update table: ${tableKey(table)}`);
            },
          };
        },
      };
    },
    // Captures the artifact_bindings raw upsert SQL.
    execute(query: { __sql_kind: 'binding_upsert'; __row: BindingRow }) {
      if (query.__sql_kind === 'binding_upsert') {
        const existing = store.bindings.find(
          (b) =>
            b.space_id === query.__row.space_id &&
            b.bundle_id === query.__row.bundle_id &&
            b.binding_id === query.__row.binding_id,
        );
        if (existing) {
          existing.artifact_id = query.__row.artifact_id;
          existing.bundle_artifact_key = query.__row.bundle_artifact_key;
        } else {
          store.bindings.push(query.__row);
        }
      }
      return Promise.resolve();
    },
  };
}

// ============================================================================
// Mock the drizzle-orm primitives used by applyArtifactSeeds
// ============================================================================

// Replace `and`, `eq`, `sql` with shapes the mock recognizes. We intercept
// the Drizzle column-vs-value predicates by capturing the column path and
// returning a closure the mock's `.where(predicate)` invokes.

import { vi } from 'vitest';

vi.mock('drizzle-orm', () => {
  type Pred = { __test_filter: (row: Record<string, unknown>) => boolean };
  return {
    and(...preds: Pred[]): Pred {
      return {
        __test_filter: (row) => preds.every((p) => p.__test_filter(row)),
      };
    },
    eq(col: { __column: string }, value: unknown): Pred {
      return {
        __test_filter: (row) => row[col.__column] === value,
      };
    },
    isNull(col: { __column: string }): Pred {
      return {
        __test_filter: (row) => row[col.__column] == null,
      };
    },
    sql: Object.assign(
      (parts: TemplateStringsArray, ...exprs: unknown[]) => ({
        __sql_kind: 'binding_upsert',
        __row: {
          space_id: String(exprs[0]),
          bundle_id: String(exprs[1]),
          binding_id: String(exprs[2]),
          artifact_id: String(exprs[3]),
          bundle_artifact_key: String(exprs[4]),
          enabled: true,
        } satisfies BindingRow,
        // Keep `parts` so the test mock can also inspect raw SQL if needed.
        __parts: parts,
      }),
      { raw: (parts: string[]) => parts.join('') },
    ),
  };
});

vi.mock('@aflow/database', () => ({
  uiArtifacts: '__uiArtifacts',
  uiArtifactVersions: '__uiArtifactVersions',
  artifactBindings: '__artifactBindings',
}));

// The column references arrive as `uiArtifacts.spaceId` etc. With the
// table-as-string mock above, accessing `.spaceId` on a string would
// throw, so we cast through an intermediary that returns a `__column`
// marker. This is hacky but keeps the mock surface tiny.
const tableColumnHandler = (table: string): ProxyHandler<object> => ({
  get(_target, prop) {
    if (prop === '__table') return `__${table}`;
    return { __column: columnNameFor(table, String(prop)) };
  },
});
function columnNameFor(_table: string, prop: string): string {
  const map: Record<string, string> = {
    spaceId: 'space_id',
    bundleArtifactKey: 'bundle_artifact_key',
    artifactId: 'artifact_id',
    versionId: 'id',
    bindingId: 'binding_id',
    bundleId: 'bundle_id',
    version: 'version',
    id: 'id',
    deletedAt: 'deleted_at',
    currentVersion: 'current_version',
  };
  return map[prop] ?? prop;
}

// ============================================================================
// Replace the imported table identifiers with Proxy(column-accessor) ones.
// ============================================================================

import * as db from '@aflow/database';
(db as unknown as Record<string, unknown>)['uiArtifacts'] = new Proxy(
  {},
  tableColumnHandler('uiArtifacts'),
);
(db as unknown as Record<string, unknown>)['uiArtifactVersions'] = new Proxy(
  {},
  tableColumnHandler('uiArtifactVersions'),
);
(db as unknown as Record<string, unknown>)['artifactBindings'] = new Proxy(
  {},
  tableColumnHandler('artifactBindings'),
);

// ============================================================================
// Test seed builder
// ============================================================================

function buildSeed(overrides: Partial<BundleArtifactSeed> = {}): BundleArtifactSeed {
  return {
    bindingId: 'portfolio-review-card',
    bundleArtifactKey: 'alpaca:portfolio-review-card',
    name: 'Portfolio Review Card',
    kind: 'react_tsx',
    source: 'export default function Card({ data }) { return null; }',
    dataSchema: { type: 'object' },
    sampleData: { foo: 'bar' },
    catalogPin: { catalogId: 'phoenix-ds', catalogVersion: '1.0.0', catalogHash: 'abc' },
    tags: [],
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('applyArtifactSeeds (Plan 158 §4.2)', () => {
  let store: Store;
  beforeEach(() => {
    store = { artifacts: [], versions: [], bindings: [] };
  });

  // The mock tx setup is intricate enough that we need to skip the inner
  // implementation tests until the schema package re-exports its actual
  // column metadata in a way our mock can intercept. The shapes here serve
  // as a structural sketch; full coverage lives in the integration test
  // (Phase 1.5, against a real Postgres). For now we assert the public
  // contract through a lightweight smoke test.

  it('returns empty result when bundle has no artifactSeed entries', async () => {
    const tx = makeTx(store) as unknown as Parameters<typeof applyArtifactSeeds>[0]['tx'];
    const result = await applyArtifactSeeds({
      bundle: { bundleId: 'b1', artifactSeed: [] },
      tenantId: '00000000-0000-0000-0000-000000000099',
      spaceId: '00000000-0000-0000-0000-000000000001',
      tx,
    });
    expect(result.entries).toEqual([]);
    expect(result.installedArtifactBindings).toEqual([]);
    expect(result.skippedArtifactBindings).toEqual([]);
    expect(store.artifacts).toHaveLength(0);
  });

  // Inserts/updates against the in-memory store are deferred to the
  // integration test that runs against a real tenant schema. The unit
  // contract above (zero-seed no-op) is the deterministic part the
  // mock-free harness can validate today.
  it.todo('first install inserts artifact head + version 1 + binding');
  it.todo('reinstall with identical source returns skipped_unchanged');
  it.todo('reinstall with changed source bumps current_version + sets parent_version_id');

  const definition = AppletDefinitionSchema.parse({
    appletKey: 'team-counter',
    version: 1,
    name: 'Team Counter',
    description: 'A counter the team increments together',
    semanticDescription: 'A shared tally anyone can set.',
    stateSchema: {
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
      additionalProperties: false,
    },
    initialState: { count: 0 },
    actions: [
      {
        name: 'set_count',
        description: 'Set the tally',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value'],
          additionalProperties: false,
        },
        patch: {
          template: [{ op: 'replace', path: '/state/count', valueFrom: '/input/value' }],
        },
      },
    ],
  });

  it('a source past the inline cap lands content-addressed, and reads back whole', async () => {
    const bigSource = `export default function Big() { return null; } // ${'x'.repeat(70_000)}`;
    const payloadStore = createMemoryPayloadStore();
    const tx = makeTx(store) as unknown as Parameters<typeof applyArtifactSeeds>[0]['tx'];
    const result = await applyArtifactSeeds({
      bundle: { bundleId: 'demo', artifactSeed: [buildSeed({ source: bigSource })] },
      tenantId: '00000000-0000-0000-0000-000000000099',
      spaceId: '00000000-0000-0000-0000-000000000001',
      tx,
      payloadStore,
    });
    expect(result.entries[0]?.outcome).toBe('inserted_new');
    const sourceRef = store.versions[0]?.source_ref as string;
    expect(sourceRef.startsWith('inline:')).toBe(false);
    expect(await payloadStore.retrieve(sourceRef as never)).toBe(bigSource);
  });

  it('a small source stays inline — the cheap lane is still the default', async () => {
    const payloadStore = createMemoryPayloadStore();
    const tx = makeTx(store) as unknown as Parameters<typeof applyArtifactSeeds>[0]['tx'];
    await applyArtifactSeeds({
      bundle: { bundleId: 'demo', artifactSeed: [buildSeed()] },
      tenantId: '00000000-0000-0000-0000-000000000099',
      spaceId: '00000000-0000-0000-0000-000000000001',
      tx,
      payloadStore,
    });
    expect((store.versions[0]?.source_ref as string).startsWith('inline:')).toBe(true);
  });

  it('a large source with no store to take it fails by name, not as an encoder throw', async () => {
    const tx = makeTx(store) as unknown as Parameters<typeof applyArtifactSeeds>[0]['tx'];
    await expect(
      applyArtifactSeeds({
        bundle: {
          bundleId: 'demo',
          artifactSeed: [buildSeed({ source: 'x'.repeat(70_000) })],
        },
        tenantId: '00000000-0000-0000-0000-000000000099',
        spaceId: '00000000-0000-0000-0000-000000000001',
        tx,
      }),
    ).rejects.toThrow(/no payload store/);
  });

  it('installs an applet-kind seed, pinning definition + hash on the version row', async () => {
    const seed = buildSeed({
      bindingId: 'team-counter',
      bundleArtifactKey: 'demo:team-counter',
      kind: 'applet',
      source: `document.body.append('counter');`,
      appletDefinition: definition,
    });
    const tx = makeTx(store) as unknown as Parameters<typeof applyArtifactSeeds>[0]['tx'];
    const result = await applyArtifactSeeds({
      bundle: { bundleId: 'demo', artifactSeed: [seed] },
      tenantId: '00000000-0000-0000-0000-000000000099',
      spaceId: '00000000-0000-0000-0000-000000000001',
      tx,
    });
    expect(result.entries[0]?.outcome).toBe('inserted_new');
    expect(result.installedArtifactBindings).toEqual(['team-counter']);
    expect(store.artifacts[0]?.kind).toBe('applet');
    expect(store.versions).toHaveLength(1);
    expect(store.versions[0]?.applet_definition).toEqual(definition);
    expect(store.versions[0]?.definition_hash).toBe(computeAppletDefinitionHash(definition));
    expect(store.bindings[0]?.binding_id).toBe('team-counter');
  });

  it('folds the definition into the render-contract hash without churning definition-less seeds', () => {
    const base = buildSeed();
    expect(renderContractHash(base)).toBe(renderContractHash(buildSeed()));
    expect(renderContractHash(base)).not.toBe(
      renderContractHash(buildSeed({ appletDefinition: definition })),
    );
  });
});
