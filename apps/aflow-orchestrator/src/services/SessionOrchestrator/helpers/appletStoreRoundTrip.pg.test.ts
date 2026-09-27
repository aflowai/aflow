/**
 * Install → instantiate → play, against a real database: the curated
 * work-board listing installs from the store, an instance pins the installed
 * version, its declared actions lower to typed tool specs (what Helmsman in
 * the installing space sees without being told anything), and a template
 * action applies through the command gateway.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { applyAppletCommand } from '@aflow/applet-runtime';
import {
  createAppletPersistence,
  createDatabase,
  createTenantContext,
  spaces,
  withTenantSchema,
} from '@aflow/database';
import { appletArtifactKey, executeStoreInstall } from '@aflow/cybernetic-runtime';
import { appletStatePath, type AppletInstance, type TenantId } from '@aflow/schemas';
import { mapAppletActionsToToolSpecs } from './appletToolMapper.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE = '55ed0000-0000-4000-8000-0000000000f4';
const ACTOR = '55ed0000-0000-4000-8000-0000000000f5';
const CATALOG_ID = 'work-board';

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('Plan 264 Phase 6 — store install → instantiate → play (real DB)', () => {
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
          { id: SPACE, name: 'Applet Round Trip', slug: `applet-rt-${randomUUID().slice(0, 8)}` },
        ]);
    });
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  it('installed applet lowers its actions for the agent and plays through the gateway', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }

    // ── Install from the store ───────────────────────────────────────────
    const installed = await executeStoreInstall({
      db,
      redis: null,
      tenantId: TENANT_ID as TenantId,
      spaceId: SPACE,
      actorUserId: ACTOR,
      catalogId: CATALOG_ID,
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const result = installed.response.result;
    expect(result.kind).toBe('applet');
    if (result.kind !== 'applet') return;
    expect(result.bundleArtifactKey).toBe(appletArtifactKey(CATALOG_ID));

    // ── Instantiate the installed artifact ───────────────────────────────
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

    // ── The definition resolves and its actions lower to tool specs ──────
    const record = await persistence.transact((tx) => tx.loadInstanceForUpdate(instanceId));
    expect(record).not.toBeNull();
    if (record === null) return;

    const specs = mapAppletActionsToToolSpecs({
      instance: record.instance,
      definition: record.definition,
      stateVersion: record.stateVersion,
    });
    expect(specs.map((spec) => spec.toolId)).toEqual([
      'work-board.add_card',
      'work-board.move_card',
      'work-board.set_budget',
      'work-board.set_title',
      'work-board.close_board',
      'work-board.raw_patch',
    ]);
    for (const spec of specs) {
      expect(spec.appletMeta?.instanceId).toBe(instanceId);
      expect(spec.appletMeta?.baseVersion).toBe(record.stateVersion);
    }

    // ── Play a declared template action through the gateway ──────────────
    const played = await applyAppletCommand({
      persistence,
      instanceId,
      actor: { kind: 'agent', agentRole: 'helmsman' },
      spaceRole: 'editor',
      command: {
        actionId: randomUUID(),
        baseVersion: record.stateVersion,
        name: 'add_card',
        input: { columnIndex: 0, card: { id: 'card-1', text: 'Ship Phase 6' } },
      },
    });
    expect(played.status).toBe('applied');
    if (played.status !== 'applied') return;
    const columns = played.state['columns'] as Array<{
      id: string;
      cards: Array<{ text: string }>;
    }>;
    expect(columns[0]?.cards[0]?.text).toBe('Ship Phase 6');
    expect(played.receipt.name).toBe('add_card');
    expect(played.receipt.actor).toEqual({ kind: 'agent', agentRole: 'helmsman' });
  });
});
