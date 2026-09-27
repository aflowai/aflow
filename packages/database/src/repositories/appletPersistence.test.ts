import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import {
  AppletDefinitionSchema,
  appletStatePath,
  type AppletCommand,
  type AppletDefinition,
} from '@aflow/schemas';
import { applyAppletCommand, type AppletPersistence } from '@aflow/applet-runtime';
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
import { createAppletPersistence } from './appletInstances.js';
import { createMemoryDocRepository } from './memoryDocs.js';
import { createMemoryDirRepository } from './memoryDirs.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;

const describeDb = DATABASE_URL ? describe : describe.skip;

const definition: AppletDefinition = AppletDefinitionSchema.parse({
  appletKey: 'work-board',
  version: 1,
  name: 'Work Board',
  description: 'A shared work item',
  semanticDescription: 'A board people and the agent operate together',
  stateSchema: {
    type: 'object',
    properties: {
      budget: { type: 'number' },
      notes: { type: 'object', additionalProperties: { type: 'string' } },
    },
    additionalProperties: false,
  },
  initialState: { budget: 0, notes: {} },
  actions: [
    {
      name: 'set_budget',
      description: 'Set the budget',
      inputSchema: {
        type: 'object',
        properties: { amount: { type: 'number' } },
        required: ['amount'],
        additionalProperties: false,
      },
      patch: { template: [{ op: 'replace', path: '/state/budget', valueFrom: '/input/amount' }] },
    },
    {
      name: 'add_note',
      description: 'Add a note under an id',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'text'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'add',
            pathTemplate: ['/state/notes', { from: '/input/id' }],
            valueFrom: '/input/text',
          },
        ],
      },
    },
    {
      name: 'edit_notes',
      description: 'Edit notes freely',
      inputSchema: { type: 'object' },
      patch: 'actor_supplied',
    },
  ],
});

describeDb('applet persistence gateway (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const dirRepo = createMemoryDirRepository(db, tenantCtx);
  const persistence = createAppletPersistence(db, tenantCtx);

  const spaceId = randomUUID();
  const artifactId = randomUUID();
  const artifactVersionId = randomUUID();
  const definitionHash = `sha256:${randomUUID()}`;
  const actorUserId = randomUUID();

  let schemaReady = false;

  async function createInstance(): Promise<string> {
    const instanceId = randomUUID();
    const statePath = appletStatePath(instanceId);
    const content = JSON.stringify({ state: definition.initialState });
    await dirRepo.ensureParentDirs(statePath, { spaceId });
    await docRepo.put({
      path: statePath,
      writeMode: 'create',
      docType: 'applet_state',
      mimeType: 'application/json',
      inlineContent: content,
      payloadRef: null,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      contentHash: randomUUID(),
      preview: null,
      tags: [],
      summary: null,
      indexing: 'disabled',
      scope: { spaceId },
    });
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(appletInstances).values({
        id: instanceId,
        spaceId,
        appletKey: definition.appletKey,
        definitionHash,
        artifactVersionId,
        statePath,
        status: 'active',
      });
    });
    return instanceId;
  }

  function act(
    instanceId: string,
    command: AppletCommand,
    opts?: { persistence?: AppletPersistence },
  ) {
    return applyAppletCommand({
      persistence: opts?.persistence ?? persistence,
      instanceId,
      actor: { kind: 'user', userId: actorUserId },
      spaceRole: 'editor',
      command,
    });
  }

  function command(overrides: Partial<AppletCommand>): AppletCommand {
    return {
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'set_budget',
      input: { amount: 1 },
      ...overrides,
    };
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
      await tx.delete(uiArtifactVersions).where(eq(uiArtifactVersions.id, artifactVersionId));
      await tx.delete(uiArtifacts).where(eq(uiArtifacts.id, artifactId));
      await tx.delete(memoryDocs).where(eq(memoryDocs.spaceId, spaceId));
      await tx.delete(memoryDirs).where(eq(memoryDirs.spaceId, spaceId));
      await tx.delete(spaces).where(eq(spaces.id, spaceId));
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
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(spaces).values([
        {
          id: spaceId,
          name: 'Applet Gateway Space',
          slug: `applet-gw-${randomUUID().slice(0, 8)}`,
        },
      ]);
      await tx.insert(uiArtifacts).values({
        id: artifactId,
        name: 'Work Board',
        kind: 'applet',
        spaceId,
        currentVersion: 1,
        catalogId: 'test',
        catalogVersion: '1',
        catalogHash: 'test',
      });
      await tx.insert(uiArtifactVersions).values({
        id: artifactVersionId,
        artifactId,
        version: 1,
        sourceRef: 'inline:test',
        contentHash: 'test',
        prompt: 'test fixture',
        appletDefinition: definition,
        definitionHash,
      });
    });
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

  it('loads instance + definition + state through the port and applies a command', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();

    const record = await persistence.transact((tx) => tx.loadInstanceForUpdate(instanceId));
    expect(record).not.toBeNull();
    expect(record!.instance.definitionHash).toBe(definitionHash);
    expect(record!.definition.appletKey).toBe('work-board');
    expect(record!.state).toEqual({ budget: 0, notes: {} });
    expect(record!.stateVersion).toBe(1);

    const result = await act(instanceId, command({ input: { amount: 40000 } }));
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.stateVersion).toBe(2);
    expect(result.receipt.seq).toBe(1);

    const doc = await docRepo.getByPath(appletStatePath(instanceId), spaceId);
    expect(JSON.parse(doc!.inlineContent!)).toEqual({ state: { budget: 40000, notes: {} } });
    expect(doc!.currentVersion).toBe(2);
  });

  it('concurrent writers serialize on the row lock without a lost update', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();

    const [a, b] = await Promise.all([
      act(instanceId, command({ name: 'add_note', input: { id: 'a', text: 'from a' } })),
      act(instanceId, command({ name: 'add_note', input: { id: 'b', text: 'from b' } })),
    ]);
    expect(a.status).toBe('applied');
    expect(b.status).toBe('applied');
    if (a.status !== 'applied' || b.status !== 'applied') return;
    expect([a.stateVersion, b.stateVersion].sort()).toEqual([2, 3]);
    expect([a.receipt.seq, b.receipt.seq].sort()).toEqual([1, 2]);

    const doc = await docRepo.getByPath(appletStatePath(instanceId), spaceId);
    expect(JSON.parse(doc!.inlineContent!)).toEqual({
      state: { budget: 0, notes: { a: 'from a', b: 'from b' } },
    });
  });

  it('concurrent actor-supplied writers on one baseVersion: one applies, one conflicts', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();

    const patchFor = (id: string) => [
      { op: 'add' as const, path: `/state/notes/${id}`, value: `note ${id}` },
    ];
    const [a, b] = await Promise.all([
      act(instanceId, command({ name: 'edit_notes', input: {}, proposedPatch: patchFor('a') })),
      act(instanceId, command({ name: 'edit_notes', input: {}, proposedPatch: patchFor('b') })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['applied', 'conflict']);
    const conflicted = a.status === 'conflict' ? a : b;
    if (conflicted.status === 'conflict') {
      expect(conflicted.currentVersion).toBe(2);
    }
    expect(await journalRows(instanceId)).toHaveLength(1);
  });

  it('idempotent replay returns the original receipt without a second write', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();
    const cmd = command({ input: { amount: 5 }, outcome: 'budget set' });

    const first = await act(instanceId, cmd);
    const replay = await act(instanceId, cmd);
    expect(first.status).toBe('applied');
    expect(replay.status).toBe('applied');
    if (first.status !== 'applied' || replay.status !== 'applied') return;
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(first.receipt);
    expect(await journalRows(instanceId)).toHaveLength(1);
    const doc = await docRepo.getByPath(appletStatePath(instanceId), spaceId);
    expect(doc!.currentVersion).toBe(2);

    const mismatch = await act(instanceId, { ...cmd, input: { amount: 6 } });
    expect(mismatch.status).toBe('rejected');
    if (mismatch.status !== 'rejected') return;
    expect(mismatch.reason).toBe('idempotency_mismatch');
  });

  it('actor-supplied stale baseVersion conflicts; template stale baseVersion rematerializes', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();
    await act(instanceId, command({ input: { amount: 10 } }));

    const stale = await act(
      instanceId,
      command({
        name: 'edit_notes',
        input: {},
        baseVersion: 1,
        proposedPatch: [{ op: 'add' as const, path: '/state/notes/x', value: 'stale' }],
      }),
    );
    expect(stale).toEqual({ status: 'conflict', currentVersion: 2 });

    const rebased = await act(instanceId, command({ baseVersion: 1, input: { amount: 20 } }));
    expect(rebased.status).toBe('applied');
    if (rebased.status !== 'applied') return;
    expect(rebased.receipt.beforeVersion).toBe(2);
    expect(rebased.receipt.afterVersion).toBe(3);
  });

  it('snapshot and journal commit atomically — a failure after the journal write rolls back both', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();

    const failing: AppletPersistence = {
      transact: (fn) =>
        persistence.transact((tx) =>
          fn({
            ...tx,
            appendJournalEntry: async (entry) => {
              await tx.appendJournalEntry(entry);
              throw new Error('induced failure after journal write');
            },
          }),
        ),
    };

    const cmd = command({ input: { amount: 99 } });
    await expect(act(instanceId, cmd, { persistence: failing })).rejects.toThrow(
      'induced failure after journal write',
    );

    expect(await journalRows(instanceId)).toHaveLength(0);
    const doc = await docRepo.getByPath(appletStatePath(instanceId), spaceId);
    expect(doc!.currentVersion).toBe(1);
    expect(JSON.parse(doc!.inlineContent!)).toEqual({ state: { budget: 0, notes: {} } });

    const retry = await act(instanceId, cmd);
    expect(retry.status).toBe('applied');
    if (retry.status !== 'applied') return;
    expect(retry.replayed).toBe(false);
    expect(retry.stateVersion).toBe(2);
  });
});
