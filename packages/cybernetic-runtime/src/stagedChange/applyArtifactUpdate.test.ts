import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StagedChange } from '@aflow/schemas';
import { RatificationApplyError } from './applyRatifiedOps.js';

// Per-test mutable state for the mocked DB. Reset in beforeEach.
type Row = Record<string, unknown>;
let draftRows: Row[] = [];
let artifactRows: Row[] = [];
let parentVersionRows: Row[] = [];
let bindingRows: Row[] = [];
let lastUpdateArtifactSql: string | null = null;
let lastInsertVersionSql: string | null = null;
let lastInsertVersionValues: unknown[] = [];
let lastDeleteDraftSql: string | null = null;

// Decompose a Drizzle `sql` template object into a flat text fragment
// (literal SQL chunks only) — used to route the mocked tx.execute by
// inspecting the leading verb + table name. Mirrors the pattern in
// `alpacaPortfolioCompanionInstall.test.ts`.
function decomposeSqlText(query: unknown): string {
  const q = query as { queryChunks?: Array<unknown> };
  const chunks = q?.queryChunks ?? [];
  let text = '';
  for (const c of chunks) {
    if (c == null) continue;
    if (typeof c === 'object' && 'value' in c) {
      const v = (c as { value?: unknown }).value;
      if (Array.isArray(v)) {
        for (const part of v) if (typeof part === 'string') text += part;
      }
    }
  }
  return text.toLowerCase();
}

/** Pull interpolated parameter values out of a Drizzle sql`` template.
 *  Walks `queryChunks`, returning everything that ISN'T a literal SQL
 *  fragment (i.e. `Param` / `StringChunk` objects without a `value`
 *  array). Used by the PR #357 review-fix test to assert the INSERT
 *  carries `data_schema` from the draft, not NULL. */
function extractSqlValues(query: unknown): unknown[] {
  const q = query as { queryChunks?: Array<unknown> };
  const chunks = q?.queryChunks ?? [];
  const values: unknown[] = [];
  for (const c of chunks) {
    if (c == null) continue;
    if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') {
      values.push(c);
      continue;
    }
    if (typeof c === 'object') {
      const v = (c as { value?: unknown }).value;
      if (Array.isArray(v)) {
        // SQL fragment chunk — skip; not a parameter value.
        continue;
      }
      if (v !== undefined) values.push(v);
    }
  }
  return values;
}

vi.mock('@aflow/database', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    createTenantContext: () => ({ schema: 'test' }),
    withTenantSchema: async <T>(
      _db: unknown,
      _tenantCtx: unknown,
      callback: (tx: unknown) => Promise<T>,
    ): Promise<T> => {
      const tx = {
        execute: async (query: unknown) => {
          const text = decomposeSqlText(query);
          // Order matters — `from ui_artifact_versions` would match a
          // `from ui_artifacts` substring check; route the more
          // specific tables first.
          // Order matters — DELETE FROM also matches the substring
          // `from ui_artifact_drafts`; route mutations first so the
          // SELECT branches don't swallow them.
          if (text.includes('delete from ui_artifact_drafts')) {
            lastDeleteDraftSql = text;
            return [];
          }
          if (text.includes('insert into ui_artifact_versions')) {
            lastInsertVersionSql = text;
            lastInsertVersionValues = extractSqlValues(query);
            return [];
          }
          if (text.includes('update ui_artifacts')) {
            lastUpdateArtifactSql = text;
            return [];
          }
          if (text.includes('from ui_artifact_drafts')) return draftRows;
          if (text.includes('from ui_artifact_versions')) return parentVersionRows;
          if (text.includes('from artifact_bindings')) return bindingRows;
          if (text.includes('from ui_artifacts')) return artifactRows;
          return [];
        },
      };
      return callback(tx);
    },
  };
});

vi.mock('../logger.js', () => ({
  getCyberneticLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

vi.mock('../artifactBindingResolver.js', () => ({
  invalidateArtifactBindingCache: vi.fn(),
}));

const { applyArtifactUpdateOps } = await import('./applyArtifactUpdate.js');
const { invalidateArtifactBindingCache } =
  (await import('../artifactBindingResolver.js')) as unknown as {
    invalidateArtifactBindingCache: ReturnType<typeof vi.fn>;
  };

const ARTIFACT_ID = '00000000-0000-0000-0000-000000000111';
const DRAFT_ID = '00000000-0000-0000-0000-000000000222';
const RUN_ID = '00000000-0000-0000-0000-000000000333';

function makeStagedChange(): StagedChange {
  // Cast through unknown — fixture covers only the fields the apply
  // path reads (kind + proposal.ops); upstream pin tests cover the
  // schema's full shape.
  return {
    kind: 'artifact_update',
    proposal: {
      ops: [
        {
          op: 'update_artifact',
          artifactId: ARTIFACT_ID,
          draftId: DRAFT_ID,
          diffSummary: 'Switched chart x-axis to time-series.',
          triggeringRunId: RUN_ID,
        },
      ],
    },
  } as unknown as StagedChange;
}

function makeCtx() {
  return {
    tenantId: 'tenant-1',
    spaceId: 'space-1',
    db: {} as never,
  };
}

describe('applyArtifactUpdateOps (Plan 158 §6)', () => {
  beforeEach(() => {
    draftRows = [];
    artifactRows = [];
    parentVersionRows = [];
    bindingRows = [];
    lastUpdateArtifactSql = null;
    lastInsertVersionSql = null;
    lastInsertVersionValues = [];
    lastDeleteDraftSql = null;
    invalidateArtifactBindingCache.mockReset();
  });

  it('publishes the draft as a new version, hard-deletes the draft, and bumps current_version', async () => {
    draftRows = [
      {
        id: DRAFT_ID,
        artifact_id: ARTIFACT_ID,
        space_id: 'space-1',
        kind: 'react_tsx',
        status: 'validated',
        source_ref: `inline:${Buffer.from(JSON.stringify('export default function() { return null; }')).toString('base64')}`,
        compiled_ref: 'inline:compiled',
        html_ref: `inline:${Buffer.from(JSON.stringify('<html/>')).toString('base64')}`,
        catalog_id: 'phoenix-design-system',
        catalog_version: '2.0.0-artifact',
        catalog_hash: 'fallback',
        prompt: 'Refresh portfolio card chart axis to time-series',
        data_schema: {
          type: 'object',
          required: ['positions'],
          properties: { positions: { type: 'array' } },
        },
        validation_report: { valid: true, diagnostics: [] },
      },
    ];
    artifactRows = [{ id: ARTIFACT_ID, current_version: 3, space_id: 'space-1' }];
    parentVersionRows = [{ id: '00000000-0000-0000-0000-000000000099' }];
    bindingRows = [
      { bundle_id: 'alpaca-portfolio-companion', binding_id: 'portfolio-review-card' },
    ];

    const result = await applyArtifactUpdateOps(makeCtx(), makeStagedChange());
    expect(result.applied).toBe(true);
    expect(result.appliedOps).toEqual(['update_artifact']);
    expect(lastUpdateArtifactSql).toContain('update ui_artifacts');
    expect(lastInsertVersionSql).toContain('insert into ui_artifact_versions');
    // PR #357 review fix — DELETE the draft, don't just mark
    // status='published' (aligns with ui.artifact.publish so the draft
    // doesn't linger in operator listings).
    expect(lastDeleteDraftSql).toContain('delete from ui_artifact_drafts');
    // Cache invalidation runs per binding row.
    expect(invalidateArtifactBindingCache).toHaveBeenCalledTimes(1);
    expect(invalidateArtifactBindingCache).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      bundleId: 'alpaca-portfolio-companion',
      bindingId: 'portfolio-review-card',
    });
  });

  it('rejects when the draft is missing (Coach drift / operator deleted it)', async () => {
    draftRows = []; // not found
    artifactRows = [{ id: ARTIFACT_ID, current_version: 1, space_id: 'space-1' }];
    await expect(applyArtifactUpdateOps(makeCtx(), makeStagedChange())).rejects.toBeInstanceOf(
      RatificationApplyError,
    );
    await expect(applyArtifactUpdateOps(makeCtx(), makeStagedChange())).rejects.toThrow(
      /not found/,
    );
  });

  it('rejects when the draft status is failed', async () => {
    draftRows = [
      {
        id: DRAFT_ID,
        artifact_id: ARTIFACT_ID,
        space_id: 'space-1',
        kind: 'react_tsx',
        status: 'failed',
        source_ref: 'inline:xxx',
        html_ref: null,
        catalog_id: 'p',
        catalog_version: '2',
        catalog_hash: 'f',
      },
    ];
    await expect(applyArtifactUpdateOps(makeCtx(), makeStagedChange())).rejects.toThrow(
      /Cannot publish a failed draft/,
    );
  });

  it('rejects when the draft has no rendered HTML', async () => {
    draftRows = [
      {
        id: DRAFT_ID,
        artifact_id: ARTIFACT_ID,
        space_id: 'space-1',
        kind: 'react_tsx',
        status: 'validated',
        source_ref: 'inline:xxx',
        html_ref: null,
        catalog_id: 'p',
        catalog_version: '2',
        catalog_hash: 'f',
      },
    ];
    await expect(applyArtifactUpdateOps(makeCtx(), makeStagedChange())).rejects.toThrow(
      /no rendered HTML/,
    );
  });

  it('rejects when the artifact is uninstalled between proposal and ratification', async () => {
    draftRows = [
      {
        id: DRAFT_ID,
        artifact_id: ARTIFACT_ID,
        space_id: 'space-1',
        kind: 'react_tsx',
        status: 'validated',
        source_ref: 'inline:xxx',
        html_ref: 'inline:xxx',
        catalog_id: 'p',
        catalog_version: '2',
        catalog_hash: 'f',
      },
    ];
    artifactRows = []; // gone
    await expect(applyArtifactUpdateOps(makeCtx(), makeStagedChange())).rejects.toThrow(
      /not found in space/,
    );
  });

  it('carries draft.data_schema + validation_report + compiled_ref onto the new version row (PR #357 review fix P1)', async () => {
    // The render path's `validateDataAgainstSchema` reads `data_schema`
    // from the current version row; NULL would silently disable
    // validation. The publish op (`handlePublish` in
    // apps/aflow-executor-ui/src/handlers/uiArtifactHandler.ts) copies
    // these fields from the draft — Coach-driven updates must too, or
    // the runtime contract bundle install established gets dropped on
    // the first Coach refresh.
    const dataSchema = {
      type: 'object',
      required: ['positions', 'summary'],
      properties: { positions: { type: 'array' }, summary: { type: 'object' } },
    };
    const validationReport = { valid: true, diagnostics: [{ severity: 'info', code: 'ok' }] };
    const sourceRef = `inline:${Buffer.from(JSON.stringify('export default function() { return null; }')).toString('base64')}`;
    const compiledRef = `inline:${Buffer.from(JSON.stringify('var X = 1;')).toString('base64')}`;
    const htmlRef = `inline:${Buffer.from(JSON.stringify('<html/>')).toString('base64')}`;
    draftRows = [
      {
        id: DRAFT_ID,
        artifact_id: ARTIFACT_ID,
        space_id: 'space-1',
        kind: 'react_tsx',
        status: 'validated',
        source_ref: sourceRef,
        compiled_ref: compiledRef,
        html_ref: htmlRef,
        catalog_id: 'phoenix-design-system',
        catalog_version: '2.0.0-artifact',
        catalog_hash: 'fallback',
        prompt: 'Coach: refresh chart axis',
        data_schema: dataSchema,
        validation_report: validationReport,
      },
    ];
    artifactRows = [{ id: ARTIFACT_ID, current_version: 1, space_id: 'space-1' }];
    parentVersionRows = [{ id: '00000000-0000-0000-0000-000000000099' }];
    bindingRows = [];

    await applyArtifactUpdateOps(makeCtx(), makeStagedChange());

    // JSON.stringify(draft.data_schema) is interpolated as a STRING
    // param (the `::jsonb` cast is in the SQL fragment, not the value),
    // so the captured params contain the JSON-encoded form directly.
    // Check for the JSON substrings against the string params.
    const stringValues = lastInsertVersionValues.filter((v): v is string => typeof v === 'string');
    expect(stringValues.some((s) => s.includes('"required":["positions","summary"]'))).toBe(true);
    expect(
      stringValues.some((s) => s.includes('"diagnostics":[{"severity":"info","code":"ok"}]')),
    ).toBe(true);
    expect(lastInsertVersionValues).toContain(compiledRef);
    // The version prompt embeds both the draft prompt and the Coach
    // diff-summary annotation, so the operator UI can read either.
    expect(stringValues.some((s) => s.includes('Coach: refresh chart axis'))).toBe(true);
    expect(stringValues.some((s) => s.includes('coach-update'))).toBe(true);
  });

  it("rejects when the draft's artifact_id doesn't match the proposal's", async () => {
    draftRows = [
      {
        id: DRAFT_ID,
        artifact_id: '00000000-0000-0000-0000-000000000999', // mismatch
        space_id: 'space-1',
        kind: 'react_tsx',
        status: 'validated',
        source_ref: 'inline:xxx',
        html_ref: 'inline:xxx',
        catalog_id: 'p',
        catalog_version: '2',
        catalog_hash: 'f',
      },
    ];
    artifactRows = [{ id: ARTIFACT_ID, current_version: 1, space_id: 'space-1' }];
    await expect(applyArtifactUpdateOps(makeCtx(), makeStagedChange())).rejects.toThrow(
      /Coach attribution drift/,
    );
  });
});
