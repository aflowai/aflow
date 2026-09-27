/**
 * The collaboration proof: the seeded work-board fixture operated end to end
 * by two people and an agent through the one gateway — journal attribution,
 * replay, concurrent-writer semantics per patch mode, the viewer refusal, and
 * the structural `ends` flip.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  appletStatePath,
  type AppletActor,
  type AppletCommand,
  type AppletInstance,
  type SpaceRole,
  type TenantId,
} from '@aflow/schemas';
import {
  applyAppletCommand,
  computeAppletDefinitionHash,
  validateAgainstAppletSchema,
} from '@aflow/applet-runtime';
import { WORK_BOARD_DEFINITION } from '@aflow/platform-artifacts';
import { createDatabase } from '../connection.js';
import { createTenantContext } from '../tenant/context.js';
import { withTenantSchema } from '../tenant/queries.js';
import {
  appletActionEvents,
  appletInstances,
  appletRoleBindings,
  memoryDocs,
  memoryDirs,
  spaces,
  uiArtifacts,
  uiArtifactVersions,
} from '../schema/tenant.js';
import { seedWorkBoardArtifact } from '../seeds/workBoardApplet.js';
import { createAppletPersistence } from './appletInstances.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;

const describeDb = DATABASE_URL ? describe : describe.skip;

interface WorkBoardCard {
  id: string;
  text: string;
  owner?: string;
}

interface WorkBoardState {
  title: string;
  status: string;
  budget: number;
  columns: { id: string; name: string; cards: WorkBoardCard[] }[];
}

describeDb('work-board collaboration proof (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const persistence = createAppletPersistence(db, tenantCtx);

  const spaceId = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const actorA: AppletActor = { kind: 'user', userId: userA };
  const actorB: AppletActor = { kind: 'user', userId: userB };
  const agent: AppletActor = { kind: 'agent', agentRole: 'helmsman' };

  let schemaReady = false;
  let artifactId = '';
  let artifactVersionId = '';

  beforeAll(async () => {
    const rows = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'applet_instances'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (!schemaReady) return;
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(spaces).values([
        {
          id: spaceId,
          name: 'Work Board Proof Space',
          slug: `work-board-${randomUUID().slice(0, 8)}`,
        },
      ]);
    });
    const seeded = await seedWorkBoardArtifact(db, tenantCtx, spaceId);
    artifactId = seeded.artifactId;
    artifactVersionId = seeded.artifactVersionId;
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  function requireSchema(ctx: TestContext): boolean {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\``);
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
      if (artifactId !== '') {
        await tx.delete(uiArtifactVersions).where(eq(uiArtifactVersions.artifactId, artifactId));
        await tx.delete(uiArtifacts).where(eq(uiArtifacts.id, artifactId));
      }
      await tx.delete(memoryDocs).where(eq(memoryDocs.spaceId, spaceId));
      await tx.delete(memoryDirs).where(eq(memoryDirs.spaceId, spaceId));
      await tx.delete(spaces).where(eq(spaces.id, spaceId));
    });
  }

  /** Mirrors the POST /v1/applets flow: resolve, validate birth state, create. */
  async function instantiate(): Promise<{ instance: AppletInstance; stateVersion: number }> {
    return persistence.transact(async (tx) => {
      const resolution = await tx.resolveAppletArtifact({ spaceId, versionId: artifactVersionId });
      if (resolution.outcome !== 'resolved') {
        throw new Error(`unexpected artifact resolution: ${resolution.outcome}`);
      }
      const check = validateAgainstAppletSchema({
        schema: resolution.definition.stateSchema,
        cacheKey: `${resolution.definitionHash}#state`,
        data: resolution.definition.initialState,
      });
      if (!check.valid) {
        throw new Error(`initialState does not match stateSchema: ${check.errors.join('; ')}`);
      }
      const instanceId = randomUUID();
      const now = new Date().toISOString();
      const instance: AppletInstance = {
        instanceId,
        spaceId,
        appletKey: resolution.definition.appletKey,
        definitionHash: resolution.definitionHash,
        artifactVersionId: resolution.artifactVersionId,
        statePath: appletStatePath(instanceId),
        status: 'active',
        boundSessionId: null,
        createdBy: userA,
        createdAt: now,
        updatedAt: now,
      };
      const stateVersion = await tx.createInstance({
        instance,
        initialState: resolution.definition.initialState,
        roleBindings: [],
      });
      return { instance, stateVersion };
    });
  }

  function act(
    instanceId: string,
    actor: AppletActor,
    spaceRole: SpaceRole,
    command: AppletCommand,
  ) {
    return applyAppletCommand({ persistence, instanceId, actor, spaceRole, command });
  }

  async function journalRows(instanceId: string) {
    return withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select()
        .from(appletActionEvents)
        .where(eq(appletActionEvents.instanceId, instanceId))
        .orderBy(appletActionEvents.seq),
    );
  }

  async function loadState(instanceId: string) {
    const record = await persistence.transact((tx) => tx.loadInstanceForUpdate(instanceId));
    expect(record).not.toBeNull();
    return {
      instance: record!.instance,
      state: record!.state as unknown as WorkBoardState,
      stateVersion: record!.stateVersion,
    };
  }

  it('two people and an agent operate one item; a replay returns the original receipt', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const { instance, stateVersion } = await instantiate();
    expect(stateVersion).toBe(1);
    expect(instance.definitionHash).toBe(computeAppletDefinitionHash(WORK_BOARD_DEFINITION));

    const born = await loadState(instance.instanceId);
    expect(born.state).toEqual(WORK_BOARD_DEFINITION.initialState);
    expect(born.stateVersion).toBe(1);

    const card = { id: 'card-1', text: 'Draft the launch brief', owner: 'alice' };
    const addCommand: AppletCommand = {
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'add_card',
      input: { columnIndex: 0, card },
    };
    const added = await act(instance.instanceId, actorA, 'editor', addCommand);
    expect(added.status).toBe('applied');
    if (added.status !== 'applied') return;
    expect(added.stateVersion).toBe(2);
    expect(added.receipt.seq).toBe(1);

    const moved = await act(instance.instanceId, actorB, 'editor', {
      actionId: randomUUID(),
      baseVersion: 2,
      name: 'move_card',
      input: { cardId: 'card-1', fromColumnId: 'todo', toColumnId: 'doing' },
      proposedPatch: [
        { op: 'remove', path: '/state/columns/0/cards/0' },
        { op: 'add', path: '/state/columns/1/cards/-', value: card },
      ],
    });
    expect(moved.status).toBe('applied');
    if (moved.status !== 'applied') return;
    expect(moved.receipt.seq).toBe(2);

    const budgeted = await act(instance.instanceId, agent, 'editor', {
      actionId: randomUUID(),
      baseVersion: 3,
      name: 'set_budget',
      input: { amount: 2500 },
    });
    expect(budgeted.status).toBe('applied');
    if (budgeted.status !== 'applied') return;
    expect(budgeted.receipt.seq).toBe(3);
    expect(budgeted.stateVersion).toBe(4);
    expect(budgeted.receipt.actor).toEqual(agent);

    const rows = await journalRows(instance.instanceId);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.actionName)).toEqual(['add_card', 'move_card', 'set_budget']);
    expect(rows.map((row) => row.actorUserId)).toEqual([userA, userB, null]);
    expect(rows.map((row) => row.actorAgentRole)).toEqual([null, null, 'helmsman']);

    const after = await loadState(instance.instanceId);
    expect(after.stateVersion).toBe(4);
    expect(after.state.columns[0]!.cards).toEqual([]);
    expect(after.state.columns[1]!.cards).toEqual([card]);
    expect(after.state.budget).toBe(2500);

    const replay = await act(instance.instanceId, actorA, 'editor', addCommand);
    expect(replay.status).toBe('applied');
    if (replay.status !== 'applied') return;
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(added.receipt);
    expect(await journalRows(instance.instanceId)).toHaveLength(3);
  });

  it('concurrent same-baseVersion template commands both apply — the loser rematerializes', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const { instance } = await instantiate();

    const [a, b] = await Promise.all([
      act(instance.instanceId, actorA, 'editor', {
        actionId: randomUUID(),
        baseVersion: 1,
        name: 'add_card',
        input: { columnIndex: 0, card: { id: 'c-a', text: 'from a' } },
      }),
      act(instance.instanceId, actorB, 'editor', {
        actionId: randomUUID(),
        baseVersion: 1,
        name: 'add_card',
        input: { columnIndex: 0, card: { id: 'c-b', text: 'from b' } },
      }),
    ]);
    expect(a.status).toBe('applied');
    expect(b.status).toBe('applied');
    if (a.status !== 'applied' || b.status !== 'applied') return;
    expect([a.stateVersion, b.stateVersion].sort()).toEqual([2, 3]);
    expect([a.receipt.beforeVersion, b.receipt.beforeVersion].sort()).toEqual([1, 2]);

    const after = await loadState(instance.instanceId);
    expect(after.state.columns[0]!.cards.map((c) => c.id).sort()).toEqual(['c-a', 'c-b']);
  });

  it('concurrent same-baseVersion actor-supplied commands: one applies, one conflicts', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const { instance } = await instantiate();

    const card = { id: 'c-move', text: 'contested' };
    const seeded = await act(instance.instanceId, actorA, 'editor', {
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'add_card',
      input: { columnIndex: 0, card },
    });
    expect(seeded.status).toBe('applied');

    const moveTo = (toIndex: number, toColumnId: string): AppletCommand => ({
      actionId: randomUUID(),
      baseVersion: 2,
      name: 'move_card',
      input: { cardId: 'c-move', fromColumnId: 'todo', toColumnId },
      proposedPatch: [
        { op: 'remove', path: '/state/columns/0/cards/0' },
        { op: 'add', path: `/state/columns/${toIndex}/cards/-`, value: card },
      ],
    });
    const [a, b] = await Promise.all([
      act(instance.instanceId, actorA, 'editor', moveTo(1, 'doing')),
      act(instance.instanceId, actorB, 'editor', moveTo(2, 'done')),
    ]);
    expect([a.status, b.status].sort()).toEqual(['applied', 'conflict']);
    const conflicted = a.status === 'conflict' ? a : b;
    if (conflicted.status === 'conflict') {
      expect(conflicted.currentVersion).toBe(3);
    }
    expect(await journalRows(instance.instanceId)).toHaveLength(2);
  });

  it('a viewer cannot write', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const { instance } = await instantiate();

    const result = await act(instance.instanceId, actorB, 'viewer', {
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'set_budget',
      input: { amount: 10 },
    });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toBe('forbidden');
    expect(await journalRows(instance.instanceId)).toHaveLength(0);
  });

  it('close_board flips the instance to ended and further actions are refused', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const { instance } = await instantiate();

    const closed = await act(instance.instanceId, actorA, 'editor', {
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'close_board',
      input: {},
    });
    expect(closed.status).toBe('applied');
    if (closed.status !== 'applied') return;
    expect(closed.receipt.effects).toEqual({ notable: false, waking: false, ending: true });
    expect((closed.state as unknown as WorkBoardState).status).toBe('closed');

    const after = await loadState(instance.instanceId);
    expect(after.instance.status).toBe('ended');

    const refused = await act(instance.instanceId, agent, 'editor', {
      actionId: randomUUID(),
      baseVersion: 2,
      name: 'set_budget',
      input: { amount: 1 },
    });
    expect(refused.status).toBe('rejected');
    if (refused.status !== 'rejected') return;
    expect(refused.reason).toBe('instance_not_active');
  });
});
