import { eq, and, desc, sql, isNull, type SQL } from 'drizzle-orm';
import { type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  type AgentId,
  type AgentSlug,
  type SessionId,
  type AgentDefinition,
  AgentDefinitionSchema,
} from '@aflow/schemas';
import {
  agents,
  agentVersions,
  agentSlugHistory,
  sessions,
  type AgentRow,
  type AgentVersionRow,
  type SessionRow,
  type NewSessionRow,
} from '../schema/tenant.js';
import { withTenantSchema, type TenantContext } from '../tenant.js';

// ============================================================================
// Session status (unchanged)
// ============================================================================

export type SessionStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'PAUSED'
  | 'WAITING_ON_CHILD'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'CANCELLING'
  | 'STALLED';

// ============================================================================
// Custom-agent repository
// ============================================================================

export interface CreateAgentParams {
  spaceId: string;
  slug: AgentSlug;
  name: string;
  description?: string;
  initialVersion: {
    version: string;
    definition: AgentDefinition;
    createdBy?: string;
  };
}

export interface AgentRepository {
  /** Create a new custom agent + its initial version atomically. */
  create(params: CreateAgentParams): Promise<{ agent: AgentRow; version: AgentVersionRow }>;

  /** Get a custom agent by its UUID. */
  getById(agentId: AgentId): Promise<AgentRow | null>;

  /** Update mutable agent metadata. On slug change, writes a row to `agent_slug_history`. */
  update(
    agentId: AgentId,
    updates: { slug?: AgentSlug; name?: string; description?: string },
    actor?: { renamedBy?: string },
  ): Promise<AgentRow | null>;

  /** Soft-delete an agent (sets `archived_at`). Idempotent. */
  archive(agentId: AgentId): Promise<void>;

  /** Reverse a soft-delete. */
  unarchive(agentId: AgentId): Promise<void>;

  publishVersion(params: {
    agentId: AgentId;
    version: string;
    definition: AgentDefinition;
    createdBy?: string;
    name?: string;
    description?: string | null;
  }): Promise<AgentVersionRow>;

  /** Get a specific version row. */
  getVersion(agentId: AgentId, version: string): Promise<AgentVersionRow | null>;

  /** Get the latest published version row. */
  getLatestVersion(agentId: AgentId): Promise<AgentVersionRow | null>;

  /** List all versions for a custom agent. */
  listVersions(agentId: AgentId): Promise<AgentVersionRow[]>;
}

/** Create a custom-agent repository for a tenant. */
export function createAgentRepository(
  db: PostgresJsDatabase,
  tenantContext: TenantContext,
): AgentRepository {
  return {
    async create(params) {
      // Validate the definition first so we don't insert an agent row whose
      // version would fail.
      const validatedDefinition = AgentDefinitionSchema.parse(params.initialVersion.definition);

      return withTenantSchema(db, tenantContext, async (tx) => {
        const [retired] = await tx
          .select({ id: agentSlugHistory.id })
          .from(agentSlugHistory)
          .where(
            and(
              eq(agentSlugHistory.spaceId, params.spaceId),
              eq(agentSlugHistory.oldSlug, params.slug),
            ),
          )
          .limit(1);
        if (retired) {
          const err = new Error(
            `SLUG_TAKEN: agent slug "${params.slug}" is retired in this space and cannot be reused while history exists for it`,
          ) as Error & { code: string };
          err.code = 'SLUG_TAKEN';
          throw err;
        }

        const [agentRow] = await tx
          .insert(agents)
          .values({
            spaceId: params.spaceId,
            slug: params.slug,
            name: params.name,
            description: params.description,
          })
          .returning();

        if (!agentRow) throw new Error('Failed to insert agent row');

        const [versionRow] = await tx
          .insert(agentVersions)
          .values({
            agentId: agentRow.id,
            version: params.initialVersion.version,
            definitionJson: validatedDefinition,
            createdBy: params.initialVersion.createdBy,
            status: 'published',
          })
          .returning();

        if (!versionRow) throw new Error('Failed to insert agent_versions row');

        return { agent: agentRow, version: versionRow };
      });
    },

    async getById(agentId) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        const [row] = await tx.select().from(agents).where(eq(agents.id, agentId)).limit(1);
        return row ?? null;
      });
    },

    async update(agentId, updates, actor) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        // Look up the current agent to (a) detect rename for history, and
        // (b) refuse mutations on archived rows.
        const [existing] = await tx
          .select({ slug: agents.slug, spaceId: agents.spaceId, archivedAt: agents.archivedAt })
          .from(agents)
          .where(eq(agents.id, agentId))
          .limit(1);
        if (!existing) return null;
        if (existing.archivedAt !== null) {
          throw new Error(`Agent ${agentId} is archived; unarchive() before mutating.`);
        }

        if (updates.slug && existing.slug !== updates.slug) {
          // Reject slugs retired via history (same rule as create) — see
          const [retired] = await tx
            .select({ id: agentSlugHistory.id })
            .from(agentSlugHistory)
            .where(
              and(
                eq(agentSlugHistory.spaceId, existing.spaceId),
                eq(agentSlugHistory.oldSlug, updates.slug),
              ),
            )
            .limit(1);
          if (retired) {
            const err = new Error(
              `SLUG_TAKEN: agent slug "${updates.slug}" is retired in this space and cannot be reused while history exists for it`,
            ) as Error & { code: string };
            err.code = 'SLUG_TAKEN';
            throw err;
          }

          await tx.insert(agentSlugHistory).values({
            agentId,
            spaceId: existing.spaceId,
            oldSlug: existing.slug,
            newSlug: updates.slug,
            renamedBy: actor?.renamedBy ?? null,
          });
        }

        const patch: Partial<AgentRow> = { updatedAt: new Date() };
        if (updates.slug) patch.slug = updates.slug;
        if (updates.name !== undefined) patch.name = updates.name;
        if (updates.description !== undefined) patch.description = updates.description;

        const [row] = await tx.update(agents).set(patch).where(eq(agents.id, agentId)).returning();
        return row ?? null;
      });
    },

    async archive(agentId) {
      await withTenantSchema(db, tenantContext, async (tx) => {
        await tx
          .update(agents)
          .set({ archivedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(agents.id, agentId), isNull(agents.archivedAt)));
      });
    },

    async unarchive(agentId) {
      await withTenantSchema(db, tenantContext, async (tx) => {
        await tx
          .update(agents)
          .set({ archivedAt: null, updatedAt: new Date() })
          .where(eq(agents.id, agentId));
      });
    },

    async publishVersion(params) {
      const validatedDefinition = AgentDefinitionSchema.parse(params.definition);
      return withTenantSchema(db, tenantContext, async (tx) => {
        // Refuse to publish a version against an archived agent.
        const [parent] = await tx
          .select({ archivedAt: agents.archivedAt })
          .from(agents)
          .where(eq(agents.id, params.agentId))
          .limit(1);
        if (!parent) {
          throw new Error(`Agent ${params.agentId} does not exist`);
        }
        if (parent.archivedAt !== null) {
          throw new Error(
            `Agent ${params.agentId} is archived; unarchive() before publishing a new version.`,
          );
        }

        const [row] = await tx
          .insert(agentVersions)
          .values({
            agentId: params.agentId,
            version: params.version,
            definitionJson: validatedDefinition,
            createdBy: params.createdBy,
            status: 'published',
          })
          .returning();
        if (!row) throw new Error('Failed to publish agent version');

        // Keep the agents row's display fields in sync with the published
        // definition. Only fire the UPDATE when the caller supplied at
        // least one of name/description — silent no-op otherwise.
        if (params.name !== undefined || params.description !== undefined) {
          const rowPatch: Record<string, unknown> = { updatedAt: new Date() };
          if (params.name !== undefined) rowPatch['name'] = params.name;
          if (params.description !== undefined) rowPatch['description'] = params.description;
          await tx.update(agents).set(rowPatch).where(eq(agents.id, params.agentId));
        }

        return row;
      });
    },

    async getVersion(agentId, version) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        const [row] = await tx
          .select()
          .from(agentVersions)
          .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.version, version)))
          .limit(1);
        return row ?? null;
      });
    },

    async getLatestVersion(agentId) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        const [row] = await tx
          .select()
          .from(agentVersions)
          .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.status, 'published')))
          .orderBy(desc(agentVersions.createdAt))
          .limit(1);
        return row ?? null;
      });
    },

    async listVersions(agentId) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select()
          .from(agentVersions)
          .where(eq(agentVersions.agentId, agentId))
          .orderBy(desc(agentVersions.createdAt));
      });
    },
  };
}

// ============================================================================
// Session repository
// ============================================================================

export interface SessionRepository {
  create(params: NewSessionRow): Promise<SessionRow>;
  getById(sessionId: SessionId): Promise<SessionRow | null>;
  update(
    sessionId: SessionId,
    updates: Partial<
      Pick<
        SessionRow,
        | 'status'
        | 'currentStepExecutionId'
        | 'endedAt'
        | 'pauseReason'
        | 'requestedInputRef'
        | 'finalOutputRef'
        | 'errorRef'
        | 'totalCostCents'
        | 'totalTokens'
        | 'hotStateSnapshot'
      >
    >,
  ): Promise<SessionRow | null>;
  /**
   * List sessions. Filters by target shape — pass `targetKind` to narrow
   * by platform-role vs custom-agent, plus `targetAgentId` /
   * `targetSystemRole` for finer scoping. The DB CHECK constraint enforces
   * tagged-shape integrity; the `targetKind` filter just makes query intent
   * crisp and guards against malformed data.
   */
  list(options?: {
    targetKind?: 'platform-role' | 'custom-agent';
    targetAgentId?: AgentId;
    targetSystemRole?: string;
    status?: SessionStatus;
    spaceId?: string;
    createdBy?: string;
    limit?: number;
    cursor?: string;
  }): Promise<SessionRow[]>;
  getByStatus(status: SessionStatus): Promise<SessionRow[]>;
  acquireSessionLock(sessionId: SessionId): Promise<boolean>;
}

export function createSessionRepository(
  db: PostgresJsDatabase,
  tenantContext: TenantContext,
): SessionRepository {
  return {
    async create(params) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        const [row] = await tx.insert(sessions).values(params).returning();
        if (!row) throw new Error('Failed to create session');
        return row;
      });
    },

    async getById(sessionId) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        const [row] = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.sessionId, sessionId))
          .limit(1);
        return row ?? null;
      });
    },

    async update(sessionId, updates) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        const [row] = await tx
          .update(sessions)
          .set(updates)
          .where(eq(sessions.sessionId, sessionId))
          .returning();
        return row ?? null;
      });
    },

    async list(options = {}) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        const conditions: SQL[] = [];

        if (options.targetKind) {
          conditions.push(eq(sessions.targetKind, options.targetKind));
        }
        if (options.targetAgentId) {
          conditions.push(eq(sessions.targetAgentId, options.targetAgentId));
        }
        if (options.targetSystemRole) {
          conditions.push(eq(sessions.targetSystemRole, options.targetSystemRole));
        }
        if (options.status) {
          conditions.push(eq(sessions.status, options.status));
        }
        if (options.spaceId) {
          conditions.push(eq(sessions.spaceId, options.spaceId));
        }
        if (options.createdBy) {
          conditions.push(eq(sessions.createdBy, options.createdBy));
        }

        // Ordered by the conversation's own clock. `started_at` sorts a room
        // someone answered an hour ago below one opened on Tuesday and left,
        // which is the wrong list every time somebody comes back to work.
        let query = tx
          .select()
          .from(sessions)
          .orderBy(desc(sessions.lastActivityAt), desc(sessions.sessionId));

        if (conditions.length > 0) {
          query = query.where(and(...conditions)) as typeof query;
        }

        if (options.limit) {
          query = query.limit(options.limit) as typeof query;
        }

        return query;
      });
    },

    async getByStatus(status) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select()
          .from(sessions)
          .where(eq(sessions.status, status))
          .orderBy(desc(sessions.startedAt));
      });
    },

    async acquireSessionLock(sessionId) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        const result = await tx.execute(
          sql`SELECT pg_try_advisory_xact_lock(hashtext(${sessionId})) as acquired`,
        );
        const rows = result as unknown as Array<{ acquired: boolean }>;
        const row = rows[0];
        return row?.acquired ?? false;
      });
    },
  };
}
