import { eq, and } from 'drizzle-orm';
import { type TenantId, type SessionAgentTarget } from '@aflow/schemas';
import { getDisclosedCallers } from '@aflow/redis';
import type { DisclosedCallerBinding } from '@aflow/schemas';
import {
  createTenantContext,
  spaces,
  users,
  agentSchedules,
  withTenantSchema,
} from '@aflow/database';
import type { AgentFlowContextDetails } from './agentTurn.js';
import type { SessionOrchestratorFactoryDeps } from '../lifecycle/context.js';

export function createBuildAgentFlowContextDetails(deps: SessionOrchestratorFactoryDeps) {
  const { db, redis } = deps;

  async function resolveSpaceName(tenantId: string, spaceId?: string): Promise<string | undefined> {
    if (!spaceId) return undefined;
    try {
      const tenantContext = createTenantContext(tenantId as TenantId);
      const rows = await withTenantSchema(db, tenantContext, async (tx) =>
        tx.select({ name: spaces.name }).from(spaces).where(eq(spaces.id, spaceId)).limit(1),
      );
      return rows[0]?.name ?? undefined;
    } catch (error) {
      console.warn(
        `[SessionOrchestrator] Failed to resolve space name for ${spaceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  async function resolveUserName(userId?: string): Promise<string | undefined> {
    if (!userId) return undefined;
    try {
      const rows = await db
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return rows[0]?.displayName ?? undefined;
    } catch (error) {
      console.warn(
        `[SessionOrchestrator] Failed to resolve user name for ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  async function resolveAgentSchedules(
    tenantId: string,
    target: SessionAgentTarget,
    spaceId: string | undefined,
  ): Promise<AgentFlowContextDetails['schedules']> {
    // Schedules only reference persistent targets (platform-role or custom-agent).
    // Inline runs never have associated schedules.
    if (target.kind === 'inline-agent') return undefined;
    if (!spaceId) return undefined;
    try {
      const tenantContext = createTenantContext(tenantId as TenantId);
      const rows = await withTenantSchema(db, tenantContext, async (tx) => {
        const baseQuery = tx
          .select({
            name: agentSchedules.name,
            kind: agentSchedules.kind,
            cronExpression: agentSchedules.cronExpression,
            timezone: agentSchedules.timezone,
            nextFireAt: agentSchedules.nextFireAt,
          })
          .from(agentSchedules);
        if (target.kind === 'platform-role') {
          return baseQuery
            .where(
              and(
                eq(agentSchedules.spaceId, spaceId),
                eq(agentSchedules.targetKind, 'platform-role'),
                eq(agentSchedules.targetSystemRole, target.systemRole),
                eq(agentSchedules.status, 'active'),
              ),
            )
            .limit(10);
        }
        // custom-agent
        return baseQuery
          .where(
            and(
              eq(agentSchedules.spaceId, spaceId),
              eq(agentSchedules.targetKind, 'custom-agent'),
              eq(agentSchedules.targetAgentId, target.agentId),
              eq(agentSchedules.status, 'active'),
            ),
          )
          .limit(10);
      });
      if (rows.length === 0) return undefined;
      return rows.map((r) => ({
        name: r.name,
        kind: r.kind,
        ...(r.cronExpression ? { cronExpression: r.cronExpression } : {}),
        ...(r.timezone ? { timezone: r.timezone } : {}),
        ...(r.nextFireAt ? { nextFireAt: r.nextFireAt.toISOString() } : {}),
      }));
    } catch {
      return undefined;
    }
  }

  return async function buildAgentFlowContextDetails(params: {
    tenantId: string;
    runId: string;
    target: SessionAgentTarget;
    spaceId?: string;
    createdBy?: string;
    trigger?: AgentFlowContextDetails['trigger'];
    voiceMode?: boolean;
    participants?: AgentFlowContextDetails['participants'];
    /**
     * Supplied by run start, which resolves it before the session hash exists —
     * the opening turn's input is materialized ahead of `atomicCreateSession`,
     * so reading it back there returns nothing. Every later turn omits it and
     * reads what that create literal stored.
     */
    disclosedCallers?: DisclosedCallerBinding[];
  }): Promise<AgentFlowContextDetails> {
    const [spaceName, userName, schedules, disclosedCallers] = await Promise.all([
      resolveSpaceName(params.tenantId, params.spaceId),
      resolveUserName(params.createdBy),
      resolveAgentSchedules(params.tenantId, params.target, params.spaceId),
      // Read, not resolved: run start already decided who this run acts for, so
      // an operator editing a simulation mid-conversation cannot change it.
      params.disclosedCallers ?? getDisclosedCallers(redis, params.tenantId, params.runId),
    ]);

    const details: AgentFlowContextDetails = {
      tenantId: params.tenantId,
      env: process.env['NODE_ENV'] === 'production' ? 'production' : 'development',
      runId: params.runId,
      ...(params.trigger ? { trigger: params.trigger } : {}),
      ...(params.voiceMode ? { voiceMode: true } : {}),
      ...(params.participants && params.participants.length > 0
        ? { participants: params.participants }
        : {}),
      ...(schedules && schedules.length > 0 ? { schedules } : {}),
      ...(disclosedCallers.length > 0 ? { disclosedCallers } : {}),
    };

    if (params.spaceId || spaceName) {
      details.space = {
        ...(params.spaceId ? { id: params.spaceId } : {}),
        name: spaceName ?? params.spaceId ?? 'unknown',
      };
    }

    if (params.createdBy || userName) {
      details.user = {
        ...(params.createdBy ? { id: params.createdBy } : {}),
        name: userName ?? params.createdBy ?? 'unknown',
      };
    }

    details.cyberneticHandles = { db, redis };

    return details;
  };
}
