/**
 * AppletPersistence over Postgres — the gateway's storage port. One
 * withTenantSchema transaction spans the `SELECT ... FOR UPDATE` on the
 * instance row (the serialization point), the state-snapshot write through
 * the memory repo, and the journal append, so they commit or roll back
 * together. The definition rides the pinned artifact version row; the state
 * body is the `{ state }` wrapper doc at the instance's statePath.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  AppletDefinitionSchema,
  type AppletActionReceipt,
  type AppletActor,
  type AppletDefinition,
  type AppletInstance,
  type AppletJournalEntry,
  type AppletStateVersion,
} from '@aflow/schemas';
import {
  AppletPersistenceError,
  type AppletInstanceListItem,
  type AppletInstanceRecord,
  type AppletPersistence,
  type AppletPersistenceTx,
} from '@aflow/applet-runtime';
import type { TenantContext } from '../tenant.js';
import { withTenantSchema } from '../tenant.js';
import {
  appletActionEvents,
  appletInstances,
  appletRoleBindings,
  uiArtifacts,
  uiArtifactVersions,
  type AppletActionEventRow,
  type AppletInstanceRow,
} from '../schema/tenant.js';
import { createMemoryDocRepository, type MemoryDocRepository } from './memoryDocs.js';
import { createMemoryDirRepository, type MemoryDirRepository } from './memoryDirs.js';

export function createAppletPersistence(
  db: PostgresJsDatabase,
  tenantContext: TenantContext,
): AppletPersistence {
  return {
    async transact<T>(fn: (tx: AppletPersistenceTx) => Promise<T>): Promise<T> {
      return withTenantSchema(db, tenantContext, async (tx) => {
        const docRepo = createMemoryDocRepository(tx, tenantContext, { inTransaction: true });
        const dirRepo = createMemoryDirRepository(tx, tenantContext, { inTransaction: true });
        return fn(createTxPort(tx, docRepo, dirRepo));
      });
    },
  };
}

function createTxPort(
  tx: PostgresJsDatabase,
  docRepo: MemoryDocRepository,
  dirRepo: MemoryDirRepository,
): AppletPersistenceTx {
  return {
    async loadInstanceForUpdate(instanceId) {
      const [row] = await tx
        .select()
        .from(appletInstances)
        .where(eq(appletInstances.id, instanceId))
        .limit(1)
        .for('update');
      if (!row) return null;
      const record: AppletInstanceRecord = {
        instance: toInstance(row),
        definition: await loadDefinition(tx, row),
        ...(await loadState(docRepo, row)),
      };
      return record;
    },

    async getJournalEntry(instanceId, actionId) {
      const [row] = await tx
        .select()
        .from(appletActionEvents)
        .where(
          and(
            eq(appletActionEvents.instanceId, instanceId),
            eq(appletActionEvents.actionId, actionId),
          ),
        )
        .limit(1);
      return row ? toJournalEntry(row) : null;
    },

    async nextSeq(instanceId) {
      const [row] = await tx
        .select({ maxSeq: sql<number>`COALESCE(MAX(${appletActionEvents.seq}), 0)` })
        .from(appletActionEvents)
        .where(eq(appletActionEvents.instanceId, instanceId));
      return (row?.maxSeq ?? 0) + 1;
    },

    async writeSnapshot(instance, state) {
      const content = JSON.stringify({ state });
      const doc = await docRepo.put({
        path: instance.statePath,
        docType: 'applet_state',
        mimeType: 'application/json',
        inlineContent: content,
        payloadRef: null,
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        contentHash: createHash('sha256').update(content).digest('hex'),
        preview: null,
        tags: [],
        summary: null,
        indexing: 'disabled',
        scope: { spaceId: instance.spaceId },
        provenance: { actor: 'system:applet-gateway' },
        writeMode: 'overwrite',
      });
      return doc.currentVersion;
    },

    async appendJournalEntry(entry) {
      const { receipt } = entry;
      await tx.insert(appletActionEvents).values({
        instanceId: entry.instanceId,
        seq: receipt.seq,
        actionId: receipt.actionId,
        actorUserId: receipt.actor.kind === 'user' ? receipt.actor.userId : null,
        actorAgentRole: receipt.actor.kind === 'agent' ? receipt.actor.agentRole : null,
        actionName: receipt.name,
        input: receipt.input,
        patch: receipt.patch,
        outcome: receipt.outcome ?? null,
        effects: receipt.effects,
        beforeVersion: receipt.beforeVersion,
        afterVersion: receipt.afterVersion,
        deliveredEffects: entry.effectDeliveries,
        createdAt: new Date(receipt.at),
      });
    },

    async touchInstance(instanceId, changes) {
      await tx
        .update(appletInstances)
        .set({
          updatedAt: new Date(),
          ...(changes?.status !== undefined ? { status: changes.status } : {}),
        })
        .where(eq(appletInstances.id, instanceId));
    },

    async repinInstance(instanceId, pin) {
      await tx
        .update(appletInstances)
        .set({
          definitionHash: pin.definitionHash,
          artifactVersionId: pin.artifactVersionId,
          upgradedFromVersionId: pin.upgradedFromVersionId,
          upgradedAt: new Date(pin.upgradedAt),
          updatedAt: new Date(pin.upgradedAt),
        })
        .where(eq(appletInstances.id, instanceId));
    },

    async listRoleBindings(instanceId) {
      const rows = await tx
        .select()
        .from(appletRoleBindings)
        .where(eq(appletRoleBindings.instanceId, instanceId));
      return rows.map((row) => ({
        instanceId: row.instanceId,
        userId: row.userId,
        roleId: row.role,
        createdAt: row.createdAt.toISOString(),
      }));
    },

    async resolveAppletArtifact(ref) {
      const versionColumns = {
        versionId: uiArtifactVersions.id,
        artifactId: uiArtifactVersions.artifactId,
        appletDefinition: uiArtifactVersions.appletDefinition,
        definitionHash: uiArtifactVersions.definitionHash,
      };
      let row:
        | {
            versionId: string;
            artifactId: string;
            appletDefinition: AppletDefinition | null;
            definitionHash: string | null;
          }
        | undefined;
      if (ref.versionId !== undefined) {
        const [joined] = await tx
          .select({ ...versionColumns, spaceId: uiArtifacts.spaceId })
          .from(uiArtifactVersions)
          .innerJoin(uiArtifacts, eq(uiArtifactVersions.artifactId, uiArtifacts.id))
          .where(eq(uiArtifactVersions.id, ref.versionId))
          .limit(1);
        if (joined?.spaceId !== ref.spaceId) return { outcome: 'not_found' };
        row = joined;
      } else if (ref.artifactId !== undefined) {
        const [artifact] = await tx
          .select({ currentVersion: uiArtifacts.currentVersion, spaceId: uiArtifacts.spaceId })
          .from(uiArtifacts)
          .where(eq(uiArtifacts.id, ref.artifactId))
          .limit(1);
        if (artifact?.spaceId !== ref.spaceId) return { outcome: 'not_found' };
        const [version] = await tx
          .select(versionColumns)
          .from(uiArtifactVersions)
          .where(
            and(
              eq(uiArtifactVersions.artifactId, ref.artifactId),
              eq(uiArtifactVersions.version, artifact.currentVersion),
            ),
          )
          .limit(1);
        if (!version) return { outcome: 'not_found' };
        row = version;
      } else {
        return { outcome: 'not_found' };
      }
      if (row.appletDefinition === null || row.definitionHash === null) {
        return { outcome: 'not_an_applet', artifactVersionId: row.versionId };
      }
      const parsed = AppletDefinitionSchema.safeParse(row.appletDefinition);
      if (!parsed.success) {
        return {
          outcome: 'definition_invalid',
          artifactVersionId: row.versionId,
          message: parsed.error.message,
        };
      }
      return {
        outcome: 'resolved',
        artifactId: row.artifactId,
        artifactVersionId: row.versionId,
        definition: parsed.data,
        definitionHash: row.definitionHash,
      };
    },

    async createInstance(seed) {
      const { instance, initialState, roleBindings } = seed;
      await dirRepo.ensureParentDirs(instance.statePath, { spaceId: instance.spaceId });
      const content = JSON.stringify({ state: initialState });
      const doc = await docRepo.put({
        path: instance.statePath,
        docType: 'applet_state',
        mimeType: 'application/json',
        inlineContent: content,
        payloadRef: null,
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        contentHash: createHash('sha256').update(content).digest('hex'),
        preview: null,
        tags: [],
        summary: null,
        indexing: 'disabled',
        scope: { spaceId: instance.spaceId },
        provenance: { actor: 'system:applet-gateway' },
        writeMode: 'create',
      });
      await tx.insert(appletInstances).values({
        id: instance.instanceId,
        spaceId: instance.spaceId,
        appletKey: instance.appletKey,
        definitionHash: instance.definitionHash,
        artifactVersionId: instance.artifactVersionId,
        statePath: instance.statePath,
        status: instance.status,
        boundSessionId: instance.boundSessionId,
        createdBy: instance.createdBy,
        createdAt: new Date(instance.createdAt),
        updatedAt: new Date(instance.updatedAt),
      });
      if (roleBindings.length > 0) {
        await tx.insert(appletRoleBindings).values(
          roleBindings.map((binding) => ({
            instanceId: instance.instanceId,
            userId: binding.userId,
            role: binding.roleId,
          })),
        );
      }
      return doc.currentVersion;
    },

    async listRecentReceipts(instanceId, limit) {
      if (limit <= 0) return [];
      const rows = await tx
        .select()
        .from(appletActionEvents)
        .where(eq(appletActionEvents.instanceId, instanceId))
        .orderBy(desc(appletActionEvents.seq))
        .limit(limit);
      return rows.map((row) => toJournalEntry(row).receipt);
    },

    async getInstance(instanceId) {
      const [row] = await tx
        .select()
        .from(appletInstances)
        .where(eq(appletInstances.id, instanceId))
        .limit(1);
      return row ? toInstance(row) : null;
    },

    async listPendingEffects(instanceId) {
      const rows = await tx
        .select()
        .from(appletActionEvents)
        .where(
          and(
            eq(appletActionEvents.instanceId, instanceId),
            sql`${appletActionEvents.deliveredEffects} @> '[{"status":"pending"}]'::jsonb`,
          ),
        )
        .orderBy(appletActionEvents.seq);
      return rows.map(toJournalEntry);
    },

    async markEffectDelivered(mark) {
      // Element-wise rewrite in one statement so two concurrent drains marking
      // different effects on the same row cannot clobber each other's update.
      await tx
        .update(appletActionEvents)
        .set({
          deliveredEffects: sql`(
            SELECT COALESCE(
              jsonb_agg(
                CASE
                  WHEN t.elem->>'effect' = ${mark.effect} AND t.elem->>'status' = 'pending'
                  THEN t.elem || ${
                    mark.attemptOnly === true
                      ? sql`jsonb_build_object(
                    'attempts', COALESCE((t.elem->>'attempts')::int, 0) + 1
                  )`
                      : sql`jsonb_build_object(
                    'status', 'delivered',
                    'deliveredAt', ${mark.deliveredAt}::text,
                    'outcome', ${mark.outcome}::text
                  )`
                  }
                  ELSE t.elem
                END
                ORDER BY t.ord
              ),
              '[]'::jsonb
            )
            FROM jsonb_array_elements(${appletActionEvents.deliveredEffects})
              WITH ORDINALITY AS t(elem, ord)
          )`,
        })
        .where(
          and(
            eq(appletActionEvents.instanceId, mark.instanceId),
            eq(appletActionEvents.actionId, mark.actionId),
          ),
        );
    },

    async listInstances(query) {
      const conditions = [
        eq(appletInstances.spaceId, query.spaceId),
        eq(appletInstances.status, query.status),
      ];
      if (query.appletKey !== undefined) {
        conditions.push(eq(appletInstances.appletKey, query.appletKey));
      }
      const where = and(...conditions);
      const [countRow] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(appletInstances)
        .where(where);
      const rows = await tx
        .select()
        .from(appletInstances)
        .where(where)
        // id tiebreaker: offset pagination over an unstable order can skip or
        // duplicate rows when updatedAt values collide at ms resolution.
        .orderBy(desc(appletInstances.updatedAt), desc(appletInstances.id))
        .limit(query.limit)
        .offset(query.offset);
      const items: AppletInstanceListItem[] = [];
      for (const row of rows) {
        const [lastEvent] = await tx
          .select()
          .from(appletActionEvents)
          .where(eq(appletActionEvents.instanceId, row.id))
          .orderBy(desc(appletActionEvents.seq))
          .limit(1);
        const lastReceipt: AppletActionReceipt | undefined = lastEvent
          ? toJournalEntry(lastEvent).receipt
          : undefined;
        items.push({
          instance: toInstance(row),
          definition: await loadDefinition(tx, row),
          ...(await loadState(docRepo, row)),
          ...(lastReceipt !== undefined ? { lastReceipt } : {}),
        });
      }
      return { items, total: countRow?.total ?? 0 };
    },
  };
}

async function loadDefinition(
  tx: PostgresJsDatabase,
  row: AppletInstanceRow,
): Promise<AppletDefinition> {
  const [versionRow] = await tx
    .select({ appletDefinition: uiArtifactVersions.appletDefinition })
    .from(uiArtifactVersions)
    .where(eq(uiArtifactVersions.id, row.artifactVersionId))
    .limit(1);
  if (versionRow?.appletDefinition == null) {
    throw new AppletPersistenceError(
      'definition_missing',
      `Artifact version '${row.artifactVersionId}' carries no applet definition`,
      row.id,
    );
  }
  const parsed = AppletDefinitionSchema.safeParse(versionRow.appletDefinition);
  if (!parsed.success) {
    throw new AppletPersistenceError(
      'definition_invalid',
      `Pinned definition on artifact version '${row.artifactVersionId}' does not parse: ${parsed.error.message}`,
      row.id,
    );
  }
  return parsed.data;
}

async function loadState(
  docRepo: MemoryDocRepository,
  row: AppletInstanceRow,
): Promise<{ state: Record<string, unknown>; stateVersion: AppletStateVersion }> {
  const doc = await docRepo.getByPath(row.statePath, row.spaceId);
  if (doc === null) {
    throw new AppletPersistenceError(
      'state_missing',
      `No state snapshot at '${row.statePath}'`,
      row.id,
    );
  }
  if (doc.inlineContent === null) {
    throw new AppletPersistenceError(
      'state_corrupt',
      `State snapshot at '${row.statePath}' has no inline content`,
      row.id,
    );
  }
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(doc.inlineContent);
  } catch {
    throw new AppletPersistenceError(
      'state_corrupt',
      `State snapshot at '${row.statePath}' is not valid JSON`,
      row.id,
    );
  }
  const state = isRecord(wrapper) ? wrapper['state'] : undefined;
  if (!isRecord(state)) {
    throw new AppletPersistenceError(
      'state_corrupt',
      `State snapshot at '${row.statePath}' lacks an object 'state' subtree`,
      row.id,
    );
  }
  return { state, stateVersion: doc.currentVersion };
}

function toInstance(row: AppletInstanceRow): AppletInstance {
  return {
    instanceId: row.id,
    spaceId: row.spaceId,
    appletKey: row.appletKey,
    definitionHash: row.definitionHash,
    artifactVersionId: row.artifactVersionId,
    statePath: row.statePath,
    status: row.status,
    boundSessionId: row.boundSessionId,
    ...(row.upgradedFromVersionId !== null
      ? { upgradedFromVersionId: row.upgradedFromVersionId }
      : {}),
    ...(row.upgradedAt !== null ? { upgradedAt: row.upgradedAt.toISOString() } : {}),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toJournalEntry(row: AppletActionEventRow): AppletJournalEntry {
  return {
    instanceId: row.instanceId,
    receipt: toReceipt(row),
    effectDeliveries: row.deliveredEffects,
  };
}

function toReceipt(row: AppletActionEventRow): AppletActionReceipt {
  const actor: AppletActor =
    row.actorAgentRole !== null
      ? { kind: 'agent', agentRole: row.actorAgentRole }
      : { kind: 'user', userId: row.actorUserId };
  return {
    actionId: row.actionId,
    seq: row.seq,
    actor,
    name: row.actionName,
    input: row.input,
    beforeVersion: row.beforeVersion,
    afterVersion: row.afterVersion,
    patch: row.patch,
    ...(row.outcome !== null ? { outcome: row.outcome } : {}),
    effects: row.effects,
    at: row.createdAt.toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
