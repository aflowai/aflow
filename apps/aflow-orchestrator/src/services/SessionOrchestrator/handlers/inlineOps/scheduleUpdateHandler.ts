import { and, eq } from 'drizzle-orm';
import {
  agentSchedules,
  createTenantContext,
  getDatabase,
  withTenantSchema,
} from '@aflow/database';
import {
  getNextCronFireTime,
  isValidTimezone,
  MAX_FIRINGS_CAP,
  MIN_CRON_INTERVAL_SECONDS,
  validateCronExpression,
} from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';
import { emitStepError, emitStepSuccess } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { getCronMinIntervalSeconds } from './scheduleCron.js';
import { scheduleConfigProblem, scheduleTargetConfig } from './scheduleTargetConfig.js';

export async function handleUpdate(
  args: InlineHandlerArgs,
  input: Record<string, unknown>,
  startTime: number,
): Promise<void> {
  const { context } = args;
  const spaceId = requireSpaceId(context);
  const scheduleId = input['scheduleId'] as string;

  if (!scheduleId) {
    await emitStepError(
      args,
      'SCHEDULE_MISSING_ID',
      'scheduleId is required.',
      startTime,
      'validation',
    );
    return;
  }

  const db = getDatabase();
  const tenantCtx = createTenantContext(context.tenantId);

  // Update changes neither the target nor the pinned version, so the row read
  // here names the version every firing of the new template will start.
  if (input['input'] !== undefined) {
    const [existing] = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select()
        .from(agentSchedules)
        .where(and(eq(agentSchedules.id, scheduleId), eq(agentSchedules.spaceId, spaceId)))
        .limit(1),
    );
    if (!existing) {
      await emitStepError(
        args,
        'SCHEDULE_NOT_FOUND',
        `Schedule ${scheduleId} not found in this space.`,
        startTime,
        'not_found',
      );
      return;
    }
    const configProblem = await scheduleConfigProblem(db, context.tenantId, {
      ...scheduleTargetConfig(existing),
      inputTemplate: input['input'],
    });
    if (configProblem) {
      await emitStepError(
        args,
        'SCHEDULE_CONFIG_NOT_DECLARED',
        `Schedule ${scheduleId} was not updated: ${configProblem}`,
        startTime,
        'validation',
      );
      return;
    }
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (input['status'] !== undefined) updates['status'] = input['status'];
  if (input['name'] !== undefined) updates['name'] = input['name'];
  if (input['description'] !== undefined) updates['description'] = input['description'];
  if (input['input'] !== undefined) updates['inputTemplate'] = input['input'];
  if (input['expiresAt'] !== undefined) {
    updates['expiresAt'] = input['expiresAt'] ? new Date(input['expiresAt'] as string) : null;
  }
  if (input['maxFirings'] !== undefined) {
    const mf = input['maxFirings'] as number;
    if (mf > MAX_FIRINGS_CAP) {
      await emitStepError(
        args,
        'SCHEDULE_MAX_FIRINGS_EXCEEDED',
        `maxFirings cannot exceed ${String(MAX_FIRINGS_CAP)}.`,
        startTime,
        'validation',
      );
      return;
    }
    updates['maxFirings'] = mf;
  }
  if (input['cron'] !== undefined) {
    const cronExpr = input['cron'] as string;
    const cronError = validateCronExpression(cronExpr);
    if (cronError) {
      await emitStepError(
        args,
        'SCHEDULE_INVALID_CRON',
        `Invalid cron: ${cronError}`,
        startTime,
        'validation',
      );
      return;
    }
    const effectiveInterval = getCronMinIntervalSeconds(
      cronExpr,
      (input['timezone'] ?? 'UTC') as string,
    );
    if (effectiveInterval !== null && effectiveInterval < MIN_CRON_INTERVAL_SECONDS) {
      await emitStepError(
        args,
        'SCHEDULE_CRON_TOO_FAST',
        'Cron fires more than once per minute.',
        startTime,
        'validation',
      );
      return;
    }
    updates['cronExpression'] = cronExpr;
    const tz = (input['timezone'] ?? 'UTC') as string;
    const next = getNextCronFireTime(cronExpr, tz);
    updates['nextFireAt'] = next ? new Date(next) : null;
  }
  if (input['timezone'] !== undefined) {
    const tz = input['timezone'] as string;
    if (!isValidTimezone(tz)) {
      await emitStepError(
        args,
        'SCHEDULE_INVALID_TIMEZONE',
        `Invalid timezone: ${tz}`,
        startTime,
        'validation',
      );
      return;
    }
    updates['timezone'] = tz;
  }

  const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
    return tx
      .update(agentSchedules)
      .set(updates)
      .where(and(eq(agentSchedules.id, scheduleId), eq(agentSchedules.spaceId, spaceId)))
      .returning({
        id: agentSchedules.id,
        status: agentSchedules.status,
        nextFireAt: agentSchedules.nextFireAt,
        updatedAt: agentSchedules.updatedAt,
      });
  });

  const row = rows[0];
  if (!row) {
    await emitStepError(
      args,
      'SCHEDULE_NOT_FOUND',
      `Schedule ${scheduleId} not found in this space.`,
      startTime,
      'not_found',
    );
    return;
  }

  await emitStepSuccess(
    args,
    {
      scheduleId: row.id,
      status: row.status,
      nextFireAt: row.nextFireAt ? row.nextFireAt.toISOString() : null,
      updatedAt: row.updatedAt.toISOString(),
    },
    startTime,
  );
}
