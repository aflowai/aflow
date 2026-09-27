/**
 * Install → instantiate → play chess, against a real database: the curated
 * chess listing installs from the store (passing the conformance gate on the
 * way in), its actions lower to typed tool specs in the described-move
 * template shape, a legal move applies through the command gateway, an
 * illegal one is refused by the guard until byAgreement is set — physics
 * always holds, legality is agreed away. Effects ride the receipts: a move is
 * silent, accept_draw is notable and ending, nudge_agent wakes.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { applyAppletCommand } from '@aflow/applet-runtime';
import type { AppletPersistence } from '@aflow/applet-runtime';
import {
  createAppletPersistence,
  createDatabase,
  createTenantContext,
  spaces,
  withTenantSchema,
} from '@aflow/database';
import { appletArtifactKey, executeStoreInstall } from '@aflow/cybernetic-runtime';
import {
  appletStatePath,
  type AppletActor,
  type AppletInstance,
  type TenantId,
} from '@aflow/schemas';
import { mapAppletActionsToToolSpecs } from './appletToolMapper.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE = '77c50000-0000-4000-8000-0000000000c5';
const ACTOR = '77c50000-0000-4000-8000-0000000000c6';
const CATALOG_ID = 'chess';

const describeDb = DATABASE_URL ? describe : describe.skip;

const HUMAN: AppletActor = { kind: 'user', userId: ACTOR };

describeDb('Plan 264 Phase 7 — chess installs, lowers, and takes any agreed move (real DB)', () => {
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
          { id: SPACE, name: 'Chess Round Trip', slug: `chess-rt-${randomUUID().slice(0, 8)}` },
        ]);
    });
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  async function instantiate(persistence: AppletPersistence, artifactId: string): Promise<string> {
    const resolution = await persistence.transact((tx) =>
      tx.resolveAppletArtifact({ spaceId: SPACE, artifactId }),
    );
    if (resolution.outcome !== 'resolved') {
      throw new Error(`chess artifact did not resolve: ${resolution.outcome}`);
    }
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
    return instanceId;
  }

  it('installs, lowers described-move templates, refuses illegal moves, and takes agreed ones', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }

    // ── Install from the store (conformance gate runs inside the seed apply) ─
    const installed = await executeStoreInstall({
      db,
      redis: null,
      tenantId: TENANT_ID as TenantId,
      spaceId: SPACE,
      actorUserId: ACTOR,
      catalogId: CATALOG_ID,
      expectedVersion: 6,
      idempotencyKey: randomUUID(),
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const result = installed.response.result;
    expect(result.kind).toBe('applet');
    if (result.kind !== 'applet') return;
    expect(result.bundleArtifactKey).toBe(appletArtifactKey(CATALOG_ID));

    const persistence = createAppletPersistence(db, tenantCtx);
    const instanceId = await instantiate(persistence, result.artifactId);

    // ── Lowering: agent-audience actions only, move in the described-move shape ─
    const record = await persistence.transact((tx) => tx.loadInstanceForUpdate(instanceId));
    expect(record).not.toBeNull();
    if (record === null) return;
    const specs = mapAppletActionsToToolSpecs({
      instance: record.instance,
      definition: record.definition,
      stateVersion: record.stateVersion,
    });
    expect(specs.map((spec) => spec.toolId)).toEqual([
      'chess.move',
      'chess.castle',
      'chess.en_passant',
      'chess.declare_result',
      'chess.resign',
      'chess.offer_draw',
      'chess.accept_draw',
      'chess.takeback_request',
      'chess.raw_patch',
    ]);
    const moveSpec = specs.find((spec) => spec.toolId === 'chess.move');
    expect(moveSpec?.appletMeta?.patchMode).toBe('template');
    const moveSchema = moveSpec?.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(moveSchema.properties)).toEqual(
      expect.arrayContaining([
        'from',
        'to',
        'piece',
        'captures',
        'places',
        'notation',
        'nextTurn',
        'outcome',
      ]),
    );
    expect(moveSchema.properties).not.toHaveProperty('proposedPatch');
    expect(moveSchema.required).toEqual([
      'from',
      'to',
      'piece',
      'captures',
      'places',
      'notation',
      'nextTurn',
    ]);

    // ── An illegal move against FRESH analysis is refused by the guard ───────
    const illegalInput = {
      from: 'd8',
      to: 'd3',
      piece: 'q',
      captures: '',
      places: 'q',
      notation: 'd8d3',
      nextTurn: 'white',
    };
    const refused = await applyAppletCommand({
      persistence,
      instanceId,
      actor: HUMAN,
      spaceRole: 'editor',
      command: {
        actionId: randomUUID(),
        baseVersion: record.stateVersion,
        name: 'move',
        input: illegalInput,
        outcome: 'black: d8-d3',
      },
    });
    expect(refused.status).toBe('rejected');
    if (refused.status !== 'rejected') return;
    expect(refused.reason).toBe('guard_rejected');

    // ── A described legal move applies (the gateway builds the patch) ────────
    const legal = await applyAppletCommand({
      persistence,
      instanceId,
      actor: HUMAN,
      spaceRole: 'editor',
      command: {
        actionId: randomUUID(),
        baseVersion: record.stateVersion,
        name: 'move',
        input: {
          from: 'e2',
          to: 'e4',
          piece: 'P',
          captures: '',
          places: 'P',
          notation: 'e2e4',
          nextTurn: 'black',
        },
        outcome: 'white: e2-e4',
      },
    });
    expect(legal.status).toBe('applied');
    if (legal.status !== 'applied') return;
    expect((legal.state['board'] as Record<string, string>)['e4']).toBe('P');
    expect(legal.receipt.effects).toEqual({ notable: false, waking: false, ending: false });

    // ── The same move WITH byAgreement applies — physics holds, legality is agreed away ─
    const illegal = await applyAppletCommand({
      persistence,
      instanceId,
      actor: HUMAN,
      spaceRole: 'editor',
      command: {
        actionId: randomUUID(),
        baseVersion: legal.stateVersion,
        name: 'move',
        input: { ...illegalInput, byAgreement: true },
        outcome: 'black: d8-d3 — illegal by agreement',
      },
    });
    expect(illegal.status).toBe('applied');
    if (illegal.status !== 'applied') return;
    expect((illegal.state['board'] as Record<string, string>)['d3']).toBe('q');
    expect((illegal.state['board'] as Record<string, string>)['d8']).toBe('');
    expect(illegal.state['moveHistory']).toEqual(['e2e4', 'd8d3']);

    // ── nudge_agent wakes (and is notable); templates need no patch ──────────
    const nudged = await applyAppletCommand({
      persistence,
      instanceId,
      actor: HUMAN,
      spaceRole: 'editor',
      command: {
        actionId: randomUUID(),
        baseVersion: illegal.stateVersion,
        name: 'nudge_agent',
        input: { message: 'please look at the board' },
      },
    });
    expect(nudged.status).toBe('applied');
    if (nudged.status !== 'applied') return;
    expect(nudged.receipt.effects).toEqual({ notable: true, waking: true, ending: false });
    expect(nudged.state['nudge']).toBe('please look at the board');

    // ── accept_draw ends the instance, notably ───────────────────────────────
    const drawn = await applyAppletCommand({
      persistence,
      instanceId,
      actor: HUMAN,
      spaceRole: 'editor',
      command: {
        actionId: randomUUID(),
        baseVersion: nudged.stateVersion,
        name: 'accept_draw',
        input: {},
      },
    });
    expect(drawn.status).toBe('applied');
    if (drawn.status !== 'applied') return;
    expect(drawn.receipt.effects).toEqual({ notable: true, waking: false, ending: true });
    expect(drawn.state['status']).toBe('ended');
    expect(drawn.state['result']).toBe('draw by agreement');

    const endedRecord = await persistence.transact((tx) => tx.loadInstanceForUpdate(instanceId));
    expect(endedRecord?.instance.status).toBe('ended');

    const afterEnd = await applyAppletCommand({
      persistence,
      instanceId,
      actor: HUMAN,
      spaceRole: 'editor',
      command: {
        actionId: randomUUID(),
        baseVersion: drawn.stateVersion,
        name: 'move',
        input: { from: 'e7', to: 'e5' },
        proposedPatch: [{ op: 'replace', path: '/state/turn', value: 'white' }],
      },
    });
    expect(afterEnd.status).toBe('rejected');
    if (afterEnd.status !== 'rejected') return;
    expect(afterEnd.reason).toBe('instance_not_active');

    // ── resign ends a fresh game, with the resigner writing the result ───────
    const secondInstanceId = await instantiate(persistence, result.artifactId);
    const secondRecord = await persistence.transact((tx) =>
      tx.loadInstanceForUpdate(secondInstanceId),
    );
    expect(secondRecord).not.toBeNull();
    if (secondRecord === null) return;
    const resigned = await applyAppletCommand({
      persistence,
      instanceId: secondInstanceId,
      actor: HUMAN,
      spaceRole: 'editor',
      command: {
        actionId: randomUUID(),
        baseVersion: secondRecord.stateVersion,
        name: 'resign',
        input: { side: 'white', result: 'white resigned — black wins' },
      },
    });
    expect(resigned.status).toBe('applied');
    if (resigned.status !== 'applied') return;
    expect(resigned.receipt.effects).toEqual({ notable: true, waking: false, ending: true });
    expect(resigned.state['status']).toBe('ended');
    expect(resigned.state['result']).toBe('white resigned — black wins');
    const resignedRecord = await persistence.transact((tx) =>
      tx.loadInstanceForUpdate(secondInstanceId),
    );
    expect(resignedRecord?.instance.status).toBe('ended');
  });
});
