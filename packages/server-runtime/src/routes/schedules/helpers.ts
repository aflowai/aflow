import type { AgentScheduleRow } from '@aflow/database';

// ============================================================================
// Helpers
// ============================================================================

export function rowToResponse(row: AgentScheduleRow): Record<string, unknown> {
  let target: Record<string, unknown> | null = null;
  let flowIdLegacy: string | null = null;
  if (row.targetKind === 'platform-role' && row.targetSystemRole) {
    target = { kind: 'platform-role', systemRole: row.targetSystemRole };
    flowIdLegacy = row.targetSystemRole;
  } else if (row.targetKind === 'custom-agent' && row.targetAgentId) {
    target = { kind: 'custom-agent', agentId: row.targetAgentId };
    flowIdLegacy = row.targetAgentId;
  }
  return {
    id: row.id,
    spaceId: row.spaceId,
    name: row.name,
    description: row.description ?? null,
    action: row.action,
    target,
    flowId: flowIdLegacy,
    flowVersion: row.agentVersion ?? null,
    targetRunId: row.targetSessionId ?? null,
    kind: row.kind,
    cronExpression: row.cronExpression ?? null,
    timezone: row.timezone,
    scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
    sourceFlowId: row.sourceAgentId ?? null,
    sourceStatus: row.sourceStatus ?? null,
    inputTemplate: row.inputTemplate ?? {},
    status: row.status,
    maxFirings: row.maxFirings ?? null,
    firingCount: row.firingCount,
    lastFiredAt: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
    lastRunId: row.lastSessionId ?? null,
    nextFireAt: row.nextFireAt ? row.nextFireAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    lastError: row.lastError ?? null,
    createdBy: row.createdBy ?? null,
    createdByRunId: row.createdBySessionId ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
