/**
 * Applet store distribution against a real database: install writes the one
 * ui_artifacts head + version with provenance, reinstall is a content-hash
 * no-op, divergence flags a space-authored version, and uninstall is
 * archive-first over live instances before the head is soft-deleted and the
 * provenance released.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import {
  createAppletPersistence,
  createDatabase,
  createTenantContext,
  spaces,
  withTenantSchema,
} from '@aflow/database';
import { appletStatePath, type AppletInstance, type TenantId } from '@aflow/schemas';
import { appletArtifactKey } from './appletArtifact.js';
import { executeStoreInstall } from './storeInstallExecution.js';
import { executeStoreUninstall } from './storeUninstallExecution.js';
import { executeStoreUpdatePreview } from './storeUpdateExecution.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE = '55ed0000-0000-4000-8000-0000000000e2';
const ACTOR = '55ed0000-0000-4000-8000-0000000000e3';
const CATALOG_ID = 'work-board';

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('Plan 264 Phase 6 — applet store distribution (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);

  let schemaReady = false;

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      for (const statement of [
        drizzleSql`DELETE FROM applet_action_events WHERE instance_id IN (SELECT id FROM applet_instances WHERE space_id = ${SPACE}::uuid)`,
        drizzleSql`DELETE FROM applet_role_bindings WHERE instance_id IN (SELECT id FROM applet_instances WHERE space_id = ${SPACE}::uuid)`,
        drizzleSql`DELETE FROM applet_instances WHERE space_id = ${SPACE}::uuid`,
        drizzleSql`DELETE FROM artifact_bindings WHERE space_id = ${SPACE}::uuid`,
        drizzleSql`DELETE FROM ui_artifact_versions WHERE artifact_id IN (SELECT id FROM ui_artifacts WHERE space_id = ${SPACE}::uuid)`,
        drizzleSql`DELETE FROM ui_artifacts WHERE space_id = ${SPACE}::uuid`,
        drizzleSql`DELETE FROM memory_docs WHERE space_id = ${SPACE}::uuid`,
        drizzleSql`DELETE FROM memory_dirs WHERE space_id = ${SPACE}::uuid`,
        drizzleSql`DELETE FROM store_install_claims WHERE space_id = ${SPACE}::uuid`,
        drizzleSql`DELETE FROM store_install_artifacts WHERE space_id = ${SPACE}::uuid`,
        drizzleSql`DELETE FROM store_installs WHERE space_id = ${SPACE}::uuid`,
        drizzleSql`DELETE FROM spaces WHERE id = ${SPACE}::uuid`,
      ]) {
        await tx.execute(statement);
      }
    });
  }

  beforeAll(async () => {
    const rows = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'applet_instances'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (!schemaReady) return;
    await cleanup();
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx
        .insert(spaces)
        .values([
          { id: SPACE, name: 'Applet Store Space', slug: `applet-${randomUUID().slice(0, 8)}` },
        ]);
    });
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  function install(idempotencyKey: string) {
    return executeStoreInstall({
      db,
      redis: null,
      tenantId: TENANT_ID as TenantId,
      spaceId: SPACE,
      actorUserId: ACTOR,
      catalogId: CATALOG_ID,
      expectedVersion: 1,
      idempotencyKey,
    });
  }

  it('install → reinstall no-op → diverged detection → uninstall archives the live instance', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }

    // ── Install ──────────────────────────────────────────────────────────
    const installed = await install(randomUUID());
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const result = installed.response.result;
    expect(result.kind).toBe('applet');
    if (result.kind !== 'applet') return;
    expect(result.outcome).toBe('inserted_new');
    expect(result.artifactVersion).toBe(1);
    expect(result.bundleArtifactKey).toBe(appletArtifactKey(CATALOG_ID));
    expect(installed.response.install.kind).toBe('applet');
    expect(installed.response.setupChecklist).toEqual([]);

    const provenance = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.execute<{ artifact_type: string; artifact_key: string; preservation: string }>(drizzleSql`
        SELECT artifact_type, artifact_key, preservation FROM store_install_artifacts
        WHERE space_id = ${SPACE}::uuid AND catalog_id = ${CATALOG_ID}
      `),
    );
    expect([...provenance]).toEqual([
      {
        artifact_type: 'ui_artifact',
        artifact_key: appletArtifactKey(CATALOG_ID),
        preservation: 'replace_on_update',
      },
    ]);

    // ── Reinstall (same version) is a content-hash no-op ─────────────────
    const reinstalled = await install(randomUUID());
    expect(reinstalled.ok).toBe(true);
    if (!reinstalled.ok) return;
    expect(reinstalled.response.result.kind).toBe('applet');
    if (reinstalled.response.result.kind !== 'applet') return;
    expect(reinstalled.response.result.outcome).toBe('skipped_unchanged');
    const versionCount = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.execute<{ count: number }>(drizzleSql`
        SELECT count(*)::int AS count FROM ui_artifact_versions
        WHERE artifact_id = ${result.artifactId}::uuid
      `),
    );
    expect(versionCount[0]?.count).toBe(1);

    // ── Pristine divergence, then a space-authored change flags modified ─
    const pristinePreview = await executeStoreUpdatePreview({
      db,
      tenantId: TENANT_ID as TenantId,
      spaceId: SPACE,
      catalogId: CATALOG_ID,
    });
    expect(pristinePreview.ok).toBe(true);
    if (!pristinePreview.ok) return;
    expect(pristinePreview.response.divergence.customized).toBe(false);

    await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.execute(drizzleSql`
        UPDATE ui_artifact_versions SET content_hash = 'space-authored-change'
        WHERE artifact_id = ${result.artifactId}::uuid AND version = 1
      `),
    );
    const divergedPreview = await executeStoreUpdatePreview({
      db,
      tenantId: TENANT_ID as TenantId,
      spaceId: SPACE,
      catalogId: CATALOG_ID,
    });
    expect(divergedPreview.ok).toBe(true);
    if (!divergedPreview.ok) return;
    expect(divergedPreview.response.divergence.customized).toBe(true);
    expect(divergedPreview.response.divergence.artifacts[0]?.state).toBe('modified');

    // ── Instantiate against the installed artifact ───────────────────────
    const persistence = createAppletPersistence(db, tenantCtx);
    const resolution = await persistence.transact((tx) =>
      tx.resolveAppletArtifact({ spaceId: SPACE, artifactId: result.artifactId }),
    );
    expect(resolution.outcome).toBe('resolved');
    if (resolution.outcome !== 'resolved') return;

    const now = new Date().toISOString();
    const instanceId = randomUUID();
    const instance: AppletInstance = {
      instanceId,
      spaceId: SPACE,
      appletKey: resolution.definition.appletKey,
      definitionHash: resolution.definitionHash,
      artifactVersionId: resolution.artifactVersionId,
      statePath: appletStatePath(instanceId),
      status: 'active',
      boundSessionId: null,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    };
    await persistence.transact((tx) =>
      tx.createInstance({
        instance,
        initialState: resolution.definition.initialState,
        roleBindings: [],
      }),
    );

    // ── Uninstall: archive-first over the live instance ──────────────────
    const uninstalled = await executeStoreUninstall({
      db,
      redis: null,
      tenantId: TENANT_ID as TenantId,
      spaceId: SPACE,
      actorUserId: ACTOR,
      catalogId: CATALOG_ID,
      idempotencyKey: randomUUID(),
    });
    expect(uninstalled.ok).toBe(true);
    if (!uninstalled.ok) return;
    expect(uninstalled.response.action).toBe('remove');
    expect(uninstalled.response.artifacts).toEqual([
      {
        artifactType: 'ui_artifact',
        artifactKey: appletArtifactKey(CATALOG_ID),
        action: 'delete',
        activeInstanceCount: 1,
      },
    ]);

    const after = await withTenantSchema(db, tenantCtx, async (tx) => ({
      instance: await tx.execute<{ status: string }>(drizzleSql`
        SELECT status FROM applet_instances WHERE id = ${instanceId}::uuid
      `),
      head: await tx.execute<{ deleted_at: string | null }>(drizzleSql`
        SELECT deleted_at FROM ui_artifacts WHERE id = ${result.artifactId}::uuid
      `),
      bindings: await tx.execute<{ binding_id: string }>(drizzleSql`
        SELECT binding_id FROM artifact_bindings WHERE space_id = ${SPACE}::uuid
      `),
      installs: await tx.execute<{ catalog_id: string }>(drizzleSql`
        SELECT catalog_id FROM store_installs WHERE space_id = ${SPACE}::uuid
      `),
    }));
    expect(after.instance[0]?.status).toBe('archived');
    expect(after.head[0]?.deleted_at).not.toBeNull();
    expect([...after.bindings]).toEqual([]);
    expect([...after.installs]).toEqual([]);
  });
});
