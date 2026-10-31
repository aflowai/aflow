import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { agentSchedules, type AgentScheduleRow, type NewAgentScheduleRow } from '@aflow/database';
import {
  getNextCronFireTime,
  isScheduleRenewalDue,
  type FlowSchedule,
  type RunAccessGrant,
} from '@aflow/schemas';
import { scheduleTargetConfig, type ScheduleTargetConfig } from './scheduleTargetConfig.js';

const SCHEDULE_SUCCESSOR_NAMESPACE = 'aflow:schedule-successor';

/**
 * The id a schedule's successor is created under. Derived from the
 * predecessor, so two overlapping renewals insert the same row and the primary
 * key keeps one.
 */
export function scheduleSuccessorId(predecessorId: string): string {
  const h = createHash('sha1').update(SCHEDULE_SUCCESSOR_NAMESPACE).update(predecessorId).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The writes a renewal makes, inside one transaction. */
export interface ScheduleRenewalStore {
  /** Reads a schedule of the space and holds it until the transaction ends. */
  lock(scheduleId: string, spaceId: string): Promise<AgentScheduleRow | undefined>;
  find(scheduleId: string): Promise<AgentScheduleRow | undefined>;
  /** Inserts the row unless its id or its predecessor's successor exists; returns it only where this call inserted it. */
  insertIfAbsent(row: NewAgentScheduleRow & { id: string }): Promise<AgentScheduleRow | undefined>;
  expireIfActive(scheduleId: string): Promise<void>;
}

export function tenantScheduleRenewalStore(tx: PostgresJsDatabase): ScheduleRenewalStore {
  return {
    async lock(scheduleId, spaceId) {
      const [row] = await tx
        .select()
        .from(agentSchedules)
        .where(and(eq(agentSchedules.id, scheduleId), eq(agentSchedules.spaceId, spaceId)))
        .limit(1)
        .for('update');
      return row;
    },
    async find(scheduleId) {
      const [row] = await tx
        .select()
        .from(agentSchedules)
        .where(eq(agentSchedules.id, scheduleId))
        .limit(1);
      return row;
    },
    async insertIfAbsent(row) {
      const [inserted] = await tx
        .insert(agentSchedules)
        .values(row)
        .onConflictDoNothing()
        .returning();
      return inserted;
    },
    async expireIfActive(scheduleId) {
      await tx
        .update(agentSchedules)
        .set({ status: 'expired', nextFireAt: null, updatedAt: new Date() })
        .where(and(eq(agentSchedules.id, scheduleId), eq(agentSchedules.status, 'active')));
    },
  };
}

export function scheduleRenewalFacts(row: AgentScheduleRow) {
  return {
    kind: row.kind as FlowSchedule['kind'],
    status: row.status as FlowSchedule['status'],
    maxFirings: row.maxFirings,
    firingCount: row.firingCount,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}

export type ScheduleRenewalOutcome =
  | { kind: 'not_found' }
  | { kind: 'not_owner' }
  | { kind: 'not_due'; predecessor: AgentScheduleRow }
  | { kind: 'config_refused'; message: string }
  | { kind: 'renewed'; successor: AgentScheduleRow; created: boolean };

/**
 * Hand a recurring schedule near its firing cap over to a successor. Only the
 * schedule's creator may renew it, and the successor carries the
 * predecessor's provenance — its creator, and the session that armed it or
 * none — because it is the same trigger continuing, not a new one armed by the
 * renewing run. The predecessor is locked for the whole decision, so an
 * owner's pause that commits first is seen, and expired with the successor's
 * insert, so the two never fire side by side. A schedule that already has its
 * successor returns it, whatever the predecessor's state since.
 */
export async function renewSchedule(
  store: ScheduleRenewalStore,
  params: {
    spaceId: string;
    predecessorId: string;
    grant: RunAccessGrant;
    /** The check a created schedule passes, which its successor passes too. */
    configProblem: (schedule: ScheduleTargetConfig) => Promise<string | null>;
  },
  now: Date = new Date(),
): Promise<ScheduleRenewalOutcome> {
  const { spaceId, predecessorId, grant, configProblem } = params;
  const predecessor = await store.lock(predecessorId, spaceId);
  if (!predecessor) return { kind: 'not_found' };
  if (predecessor.creatorUserId !== grant.grantedToUserId) return { kind: 'not_owner' };

  const successorId = scheduleSuccessorId(predecessorId);
  const existing = await store.find(successorId);
  if (existing) return { kind: 'renewed', successor: existing, created: false };
  if (!isScheduleRenewalDue(scheduleRenewalFacts(predecessor), now)) {
    return { kind: 'not_due', predecessor };
  }

  const problem = await configProblem(scheduleTargetConfig(predecessor));
  if (problem !== null) return { kind: 'config_refused', message: problem };

  const next =
    predecessor.cronExpression !== null
      ? getNextCronFireTime(predecessor.cronExpression, predecessor.timezone)
      : null;
  const inserted = await store.insertIfAbsent({
    id: successorId,
    spaceId,
    name: predecessor.name,
    description: predecessor.description,
    action: predecessor.action,
    targetKind: predecessor.targetKind,
    targetSystemRole: predecessor.targetSystemRole,
    targetAgentId: predecessor.targetAgentId,
    agentVersion: predecessor.agentVersion,
    targetSessionId: predecessor.targetSessionId,
    targetStepExecutionId: null,
    kind: predecessor.kind,
    cronExpression: predecessor.cronExpression,
    timezone: predecessor.timezone,
    scheduledAt: null,
    sourceKind: predecessor.sourceKind,
    sourceSystemRole: predecessor.sourceSystemRole,
    sourceAgentId: predecessor.sourceAgentId,
    sourceStatus: predecessor.sourceStatus,
    inputTemplate: predecessor.inputTemplate,
    status: 'active',
    maxFirings: predecessor.maxFirings,
    firingCount: 0,
    nextFireAt: next ? new Date(next) : null,
    expiresAt: predecessor.expiresAt,
    lastError: null,
    createdBy: predecessor.createdBy,
    createdBySessionId: predecessor.createdBySessionId,
    metadata: predecessor.metadata,
    creatorUserId: predecessor.creatorUserId,
    creatorTenantRole: predecessor.creatorTenantRole,
    creatorSpaceRole: predecessor.creatorSpaceRole,
    renewsScheduleId: predecessorId,
    originalScheduleId: predecessor.originalScheduleId ?? predecessorId,
  });
  await store.expireIfActive(predecessorId);

  if (inserted) return { kind: 'renewed', successor: inserted, created: true };
  const winner = await store.find(successorId);
  if (!winner) throw new Error(`Successor ${successorId} of schedule ${predecessorId} vanished.`);
  return { kind: 'renewed', successor: winner, created: false };
}
