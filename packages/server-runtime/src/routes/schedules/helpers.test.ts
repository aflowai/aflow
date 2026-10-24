import { describe, expect, it } from 'vitest';
import type { AgentScheduleRow } from '@aflow/database';
import { MAX_FIRINGS_CAP, SCHEDULE_RENEWAL_WINDOW } from '@aflow/schemas';
import { rowToResponse } from './helpers.js';

function row(firingCount: number, status = 'active'): AgentScheduleRow {
  const at = new Date('2026-10-24T08:00:00Z');
  return {
    id: '5247eee7-0000-4000-8000-000000000001',
    spaceId: 'b0000000-0000-4000-8000-000000000002',
    name: 'Local PR Shepherd',
    description: null,
    action: 'start_run',
    targetKind: 'custom-agent',
    targetSystemRole: null,
    targetAgentId: 'c0000000-0000-4000-8000-0000000000a1',
    agentVersion: null,
    targetSessionId: null,
    targetStepExecutionId: null,
    kind: 'cron',
    cronExpression: '*/5 * * * *',
    timezone: 'UTC',
    scheduledAt: null,
    sourceKind: null,
    sourceSystemRole: null,
    sourceAgentId: null,
    sourceStatus: null,
    inputTemplate: {},
    status,
    maxFirings: MAX_FIRINGS_CAP,
    firingCount,
    lastFiredAt: null,
    lastSessionId: null,
    nextFireAt: null,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    lastError: null,
    createdBy: null,
    createdBySessionId: null,
    metadata: {},
    creatorUserId: null,
    creatorTenantRole: null,
    creatorSpaceRole: null,
    createdAt: at,
    updatedAt: at,
  };
}

describe('a schedule read reports the firings it has left and whether it renews now', () => {
  it('within the window of its cap, it is due', () => {
    expect(rowToResponse(row(MAX_FIRINGS_CAP - SCHEDULE_RENEWAL_WINDOW))).toMatchObject({
      firingsLeft: SCHEDULE_RENEWAL_WINDOW,
      renewalDue: true,
    });
  });

  it('with headroom, or paused by its owner, it is not', () => {
    expect(rowToResponse(row(0))).toMatchObject({
      firingsLeft: MAX_FIRINGS_CAP,
      renewalDue: false,
    });
    expect(rowToResponse(row(MAX_FIRINGS_CAP - 1, 'paused'))).toMatchObject({
      renewalDue: false,
    });
  });
});
