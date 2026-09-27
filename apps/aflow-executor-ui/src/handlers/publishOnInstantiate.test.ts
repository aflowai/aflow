/**
 * Publish-on-instantiate against a real database: a definition-bearing draft
 * becomes a published version carrying definition + hash, the draft is
 * deleted, and the live instance pins the PUBLISHED version — so the 24h
 * draft expiry can no longer strand an applet.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type postgres from 'postgres';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type {
  AppletLibrary,
  AppletLibraryEntry,
  PayloadRef,
  TenantId,
  UiAppletInstantiateOutput,
} from '@aflow/schemas';
import { APPLET_LIBRARY_REGISTRY, AppletDefinitionSchema } from '@aflow/schemas';
import { computeAppletDefinitionHash } from '@aflow/applet-runtime';
import {
  appletActionEvents,
  appletInstances,
  appletRoleBindings,
  createAppletPersistence,
  createDatabase,
  createTenantContext,
  memoryDirs,
  memoryDocs,
  spaces,
  tenantIdToSchemaName,
  uiArtifactDrafts,
  uiArtifacts,
  uiArtifactVersions,
  withTenantSchema,
} from '@aflow/database';
import { AppletHandler } from './appletHandler.js';
import { publishDraftCore, type PublishCoreDeps } from './publishArtifactCore.js';
import { captureHermeticApplet } from './appletHermeticPublish.js';
import { wrapAppletHtml } from './appletHtmlWrapper.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;

const describeDb = DATABASE_URL ? describe : describe.skip;

const DEFINITION = AppletDefinitionSchema.parse({
  appletKey: 'team-counter',
  version: 1,
  name: 'Team Counter',
  description: 'A counter the team increments together',
  semanticDescription: 'A shared tally anyone can set; closing it ends the item.',
  stateSchema: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      status: { enum: ['open', 'closed'] },
    },
    required: ['count', 'status'],
    additionalProperties: false,
  },
  initialState: { count: 0, status: 'open' },
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
      patch: { template: [{ op: 'replace', path: '/state/count', valueFrom: '/input/value' }] },
    },
  ],
});

function inlineRef(text: string): string {
  return `inline:${Buffer.from(JSON.stringify(text), 'utf8').toString('base64')}`;
}

const DEFAULT_DRAFT_HTML = '<!doctype html><html><body>counter</body></html>';
const D3 = APPLET_LIBRARY_REGISTRY.d3;
const D3_FIXTURE = 'window.d3 = { fixture: true };';
// d3's sha256 pin is overridden to match the fixture bytes; leaflet keeps its
// real pins and the test fetcher rejects it — the offline-capture failure case.
const HERMETIC_REGISTRY: Partial<Record<AppletLibrary, AppletLibraryEntry>> = {
  d3: {
    ...D3,
    sha256: createHash('sha256').update(Buffer.from(D3_FIXTURE, 'utf8')).digest('hex'),
  },
  leaflet: APPLET_LIBRARY_REGISTRY.leaflet,
};

function decodeInlineRef(ref: string): string {
  const decoded: unknown = JSON.parse(
    Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8'),
  );
  return typeof decoded === 'string' ? decoded : JSON.stringify(decoded);
}

describeDb('publish-on-instantiate (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantId = TENANT_ID as TenantId;
  const tenantCtx = createTenantContext(tenantId);
  const persistence = createAppletPersistence(db, tenantCtx);
  const schemaName = tenantIdToSchemaName(tenantId);

  const spaceId = randomUUID();
  let schemaReady = false;

  const captureSpy = vi.fn(async (draftHtml: string) =>
    captureHermeticApplet(
      {
        fetchAsset: async (url: string): Promise<Uint8Array> => {
          if (url === D3.url) return new Uint8Array(Buffer.from(D3_FIXTURE, 'utf8'));
          throw new Error(`offline test harness (${url})`);
        },
        storeBlob: async (content: string) => inlineRef(content),
        registry: HERMETIC_REGISTRY,
      },
      draftHtml,
    ),
  );

  const deps: PublishCoreDeps = {
    withSchema: async <T>(fn: (s: postgres.Sql) => Promise<T>): Promise<T> => {
      const result = await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path TO "${schemaName}", public`);
        return await fn(tx as unknown as postgres.Sql);
      });
      return result as T;
    },
    loadBlob: async (ref) => decodeInlineRef(ref),
    captureHermeticApplet: captureSpy,
  };

  const handler = new AppletHandler(
    () => persistence,
    undefined,
    async (ctx, params) => {
      const result = await publishDraftCore(deps, {
        spaceId: params.spaceId,
        draftId: params.draftId,
        runId: ctx.runId,
        stepExecutionId: ctx.stepExecutionId,
        requireAppletDefinition: true,
      });
      if (!result.ok) return result;
      return { ok: true, artifactVersionId: result.versionId };
    },
  );

  beforeAll(async () => {
    const rows = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = ${TENANT_SCHEMA}
          AND table_name = 'ui_artifact_versions' AND column_name = 'assets_manifest'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (!schemaReady) return;
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(spaces).values([
        {
          id: spaceId,
          name: 'Publish-on-instantiate space',
          slug: `applet-publish-${randomUUID().slice(0, 8)}`,
        },
      ]);
    });
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  function requireSchema(ctx: TestContext): boolean {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not at migration 153 — run \`yarn db:migrate\``);
      return false;
    }
    return true;
  }

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      const instances = await tx
        .select({ id: appletInstances.id })
        .from(appletInstances)
        .where(eq(appletInstances.spaceId, spaceId));
      const instanceIds = instances.map((row) => row.id);
      if (instanceIds.length > 0) {
        await tx
          .delete(appletActionEvents)
          .where(inArray(appletActionEvents.instanceId, instanceIds));
        await tx
          .delete(appletRoleBindings)
          .where(inArray(appletRoleBindings.instanceId, instanceIds));
        await tx.delete(appletInstances).where(inArray(appletInstances.id, instanceIds));
      }
      const artifacts = await tx
        .select({ id: uiArtifacts.id })
        .from(uiArtifacts)
        .where(eq(uiArtifacts.spaceId, spaceId));
      const artifactIds = artifacts.map((row) => row.id);
      if (artifactIds.length > 0) {
        await tx
          .delete(uiArtifactVersions)
          .where(inArray(uiArtifactVersions.artifactId, artifactIds));
        await tx.delete(uiArtifacts).where(inArray(uiArtifacts.id, artifactIds));
      }
      await tx.delete(uiArtifactDrafts).where(eq(uiArtifactDrafts.spaceId, spaceId));
      await tx.delete(memoryDocs).where(eq(memoryDocs.spaceId, spaceId));
      await tx.delete(memoryDirs).where(eq(memoryDirs.spaceId, spaceId));
      await tx.delete(spaces).where(eq(spaces.id, spaceId));
    });
  }

  async function insertDraft(options?: {
    withDefinition?: boolean;
    kind?: string;
    html?: string;
  }): Promise<string> {
    const draftId = randomUUID();
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(uiArtifactDrafts).values({
        id: draftId,
        kind: options?.kind ?? 'react_tsx',
        spaceId,
        prompt: 'a shared counter',
        sourceRef: inlineRef('export default function Counter() { return null; }'),
        htmlRef: inlineRef(options?.html ?? DEFAULT_DRAFT_HTML),
        dataSchema: {},
        catalogId: 'phoenix-design-system',
        catalogVersion: '2.0.0-artifact',
        catalogHash: 'fallback',
        status: 'draft',
        ...(options?.withDefinition === false ? {} : { appletDefinition: DEFINITION }),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    });
    return draftId;
  }

  function makeCtx(input: unknown): { ctx: ExecutorContext; readOutput: <T>() => T } {
    const writes: Array<{ kind: string; data: unknown }> = [];
    const ctx = {
      job: { inputRef: 'inline:input' as PayloadRef },
      tenantId,
      spaceId,
      runId: randomUUID(),
      stepExecutionId: randomUUID(),
      attempt: 1,
      operationId: 'ui.applet.instantiate',
      readPayload: async () => input,
      writePayload: async (kind: string, data: unknown) => {
        writes.push({ kind, data });
        return `inline:${kind}` as PayloadRef;
      },
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    } as unknown as ExecutorContext;
    return {
      ctx,
      readOutput: <T>() => {
        const output = writes.find((write) => write.kind === 'output');
        if (!output) throw new Error('no output written');
        return output.data as T;
      },
    };
  }

  it('publishes the draft into a definition-bearing version and births a live instance', async (t) => {
    if (!requireSchema(t)) return;
    const draftId = await insertDraft();
    const { ctx, readOutput } = makeCtx({ draftId });
    const result = await handler.execute(ctx);
    expect(result.status).toBe('SUCCEEDED');
    const output = readOutput<UiAppletInstantiateOutput>();

    const expectedHash = computeAppletDefinitionHash(DEFINITION);
    expect(output.instance.definitionHash).toBe(expectedHash);
    expect(output.instance.status).toBe('active');
    expect(output.state).toEqual(DEFINITION.initialState);

    const versionRows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select()
        .from(uiArtifactVersions)
        .where(eq(uiArtifactVersions.id, output.instance.artifactVersionId)),
    );
    const version = versionRows[0];
    expect(version).toBeDefined();
    expect(version?.definitionHash).toBe(expectedHash);
    expect(version?.appletDefinition).toEqual(DEFINITION);
    expect(version?.version).toBe(1);
    // react_tsx drafts are untouched by hermetic capture — that path is
    // applet-kind only.
    expect(captureSpy).not.toHaveBeenCalled();
    expect(version?.assetsManifest).toBeNull();
    expect(version?.htmlRef).toBe(inlineRef(DEFAULT_DRAFT_HTML));

    const headRows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.select().from(uiArtifacts).where(eq(uiArtifacts.id, version!.artifactId)),
    );
    expect(headRows[0]?.name).toBe(DEFINITION.name);
    expect(headRows[0]?.currentVersion).toBe(1);
  });

  it('deletes the draft, and the instance survives on the published version alone', async (t) => {
    if (!requireSchema(t)) return;
    const draftId = await insertDraft();
    const { ctx, readOutput } = makeCtx({ draftId });
    const result = await handler.execute(ctx);
    expect(result.status).toBe('SUCCEEDED');
    const output = readOutput<UiAppletInstantiateOutput>();

    const draftRows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.select().from(uiArtifactDrafts).where(eq(uiArtifactDrafts.id, draftId)),
    );
    expect(draftRows).toHaveLength(0);

    // The 24h-expiry stand-in: with the draft gone, the pinned version still
    // resolves and the instance still loads with its definition.
    const resolution = await persistence.transact((tx) =>
      tx.resolveAppletArtifact({ spaceId, versionId: output.instance.artifactVersionId }),
    );
    expect(resolution.outcome).toBe('resolved');
    const record = await persistence.transact((tx) =>
      tx.loadInstanceForUpdate(output.instance.instanceId),
    );
    expect(record?.definition.appletKey).toBe(DEFINITION.appletKey);
    expect(record?.state).toEqual(DEFINITION.initialState);
  });

  it('refuses a definition-less draft without publishing or deleting it', async (t) => {
    if (!requireSchema(t)) return;
    const draftId = await insertDraft({ withDefinition: false });
    const { ctx } = makeCtx({ draftId });
    const result = await handler.execute(ctx);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.classification).toBe('validation');
    expect(result.error.message).toContain('applet definition');

    const draftRows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.select().from(uiArtifactDrafts).where(eq(uiArtifactDrafts.id, draftId)),
    );
    expect(draftRows).toHaveLength(1);
  });

  it('publishes an applet-kind draft hermetically: assets captured, HTML rewritten, manifest pinned', async (t) => {
    if (!requireSchema(t)) return;
    const draftHtml = wrapAppletHtml('const board = document.createElement("div");', ['d3']);
    const draftId = await insertDraft({ kind: 'applet', html: draftHtml });
    const { ctx, readOutput } = makeCtx({ draftId });
    const result = await handler.execute(ctx);
    expect(result.status).toBe('SUCCEEDED');
    const output = readOutput<UiAppletInstantiateOutput>();

    const versionRows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select()
        .from(uiArtifactVersions)
        .where(eq(uiArtifactVersions.id, output.instance.artifactVersionId)),
    );
    const version = versionRows[0];
    expect(version).toBeDefined();
    expect(version?.htmlRef).not.toBe(inlineRef(draftHtml));

    const hermeticHtml = decodeInlineRef(version!.htmlRef!);
    expect(hermeticHtml).toContain(D3_FIXTURE);
    expect(hermeticHtml).not.toContain('https://');

    const manifest = version?.assetsManifest;
    expect(manifest?.assets).toHaveLength(1);
    const captured = manifest?.assets[0];
    expect(captured?.library).toBe('d3');
    expect(captured?.asset).toBe('js');
    expect(decodeInlineRef(captured!.payloadRef)).toBe(D3_FIXTURE);
  });

  it('fails the publish when asset capture cannot reach the CDN, leaving the draft intact', async (t) => {
    if (!requireSchema(t)) return;
    const draftHtml = wrapAppletHtml('const map = document.createElement("div");', ['leaflet']);
    const draftId = await insertDraft({ kind: 'applet', html: draftHtml });
    const { ctx } = makeCtx({ draftId });
    const result = await handler.execute(ctx);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.message).toContain('could not fetch');

    const draftRows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.select().from(uiArtifactDrafts).where(eq(uiArtifactDrafts.id, draftId)),
    );
    expect(draftRows).toHaveLength(1);
  });
});
