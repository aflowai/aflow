import { randomUUID } from 'node:crypto';

import { eq, and, desc, sql } from 'drizzle-orm';
import {
  getDatabase,
  withTenantSchema,
  createTenantContext,
  agentSchedules,
} from '@aflow/database';
import {
  validateCronExpression,
  getNextCronFireTime,
  isValidTimezone,
  MAX_FIRINGS_CAP,
  ONE_SHOT_MAX_HORIZON_DAYS,
  MIN_CRON_INTERVAL_SECONDS,
  errorContext,
  agentTargetKey,
  targetToColumns,
  PersistentAgentTargetSchema,
  type AflowError,
  type PersistentAgentTarget,
} from '@aflow/schemas';
import { getSessionState } from '@aflow/redis';
import { Cron } from 'croner';
import { getRunAccessGrant } from '@aflow/redis';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';

/** Max schedules an agent can create in a single run (safety guardrail) */
const MAX_SCHEDULE_CREATES_PER_RUN = 10;

/** Default expiresAt for recurring schedules: 30 days */
const DEFAULT_RECURRING_EXPIRY_DAYS = 30;

/** Per-run counters to enforce rate limit. Map<runId, count>. */
const runScheduleCreateCounts = new Map<string, number>();

// ============================================================================
// agent.schedule.* Router
// ============================================================================

export async function handleScheduleCrudInline(args: InlineHandlerArgs): Promise<void> {
  const operationId = args.stepDef.operation;
  const startTime = Date.now();

  try {
    let input: Record<string, unknown> = {};
    try {
      const data = await args.payloadStore.retrieve(args.resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      /* empty input */
    }

    switch (operationId) {
      case 'agent.schedule.create':
        await handleCreate(args, input, startTime);
        break;
      case 'agent.schedule.get':
        await handleGet(args, input, startTime);
        break;
      case 'agent.schedule.list':
        await handleList(args, input, startTime);
        break;
      case 'agent.schedule.update':
        await handleUpdate(args, input, startTime);
        break;
      case 'agent.schedule.delete':
        await handleDelete(args, input, startTime);
        break;
      default:
        await emitStepError(
          args,
          'UNKNOWN_SCHEDULE_OPERATION',
          `Unknown schedule operation: ${operationId}`,
          startTime,
          'validation',
        );
    }
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const isSqlError =
      rawMessage.includes('Failed query:') ||
      rawMessage.includes('PostgresError') ||
      rawMessage.includes('column "');
    const message = isSqlError
      ? 'Schedule operation failed due to an internal error. Please try again or contact support.'
      : rawMessage;
    if (isSqlError) {
      const ae: AflowError = {
        code: 'SCHEDULE_CRUD_SQL_ERROR',
        message: 'Schedule operation failed due to an internal database error',
        classification: 'internal',
        retryable: false,
        timestamp: new Date().toISOString(),
      };
      getOrchestratorLogger().error(
        `[scheduleCrud] SQL error in ${args.stepDef.operation}`,
        err instanceof Error ? err : undefined,
        {
          rawMessage,
          ...errorContext(ae, {
            tenantId: args.context.tenantId,
            runId: args.context.runId,
            stepExecutionId: args.stepExecutionId,
            operationId: args.stepDef.operation,
            traceId: args.context.traceId,
            stepType: args.stepDef.stepType,
            stepId: args.stepDef.stepId,
          }),
        },
      );
    }
    await emitStepError(args, 'SCHEDULE_OPERATION_FAILED', message, startTime, 'internal');
  }
}

// ============================================================================
// agent.schedule.create
// ============================================================================

async function handleCreate(
  args: InlineHandlerArgs,
  input: Record<string, unknown>,
  startTime: number,
): Promise<void> {
  const { context } = args;
  const spaceId = requireSpaceId(context);

  // --- Rate limit: max creates per run ---
  const runId = context.runId as string;
  const currentCount = runScheduleCreateCounts.get(runId) ?? 0;
  if (currentCount >= MAX_SCHEDULE_CREATES_PER_RUN) {
    await emitStepError(
      args,
      'SCHEDULE_RATE_LIMIT',
      `Maximum ${String(MAX_SCHEDULE_CREATES_PER_RUN)} schedule creates per run exceeded.`,
      startTime,
      'rate_limit',
      true,
    );
    return;
  }
  runScheduleCreateCounts.set(runId, currentCount + 1);

  // --- Validate input is provided ---
  const scheduleInput = input['input'] as Record<string, unknown> | undefined;
  if (!scheduleInput || Object.keys(scheduleInput).length === 0) {
    await emitStepError(
      args,
      'SCHEDULE_MISSING_INPUT',
      "input is required — it becomes the scheduled run's input. Provide the fields the target flow expects.",
      startTime,
      'validation',
    );
    return;
  }

  // --- Determine trigger kind ---
  const hasCron = typeof input['cron'] === 'string' && input['cron'] !== '';
  const hasScheduledAt = typeof input['scheduledAt'] === 'string' && input['scheduledAt'] !== '';
  const hasOnComplete =
    typeof input['onFlowComplete'] === 'object' && input['onFlowComplete'] !== null;

  let kind: 'cron' | 'one_shot' | 'on_completion';
  if (hasCron) kind = 'cron';
  else if (hasScheduledAt) kind = 'one_shot';
  else if (hasOnComplete) kind = 'on_completion';
  else {
    await emitStepError(
      args,
      'SCHEDULE_MISSING_TRIGGER',
      'Provide a trigger: scheduledAt (one-shot), cron (recurring), or onFlowComplete (event-driven).',
      startTime,
      'validation',
    );
    return;
  }

  // --- Resolve "self" references + infer action ---
  let target: PersistentAgentTarget | undefined;
  const rawTarget = input['target'];
  if (rawTarget === 'self') {
    const runState = await getSessionState(args.redis, context.tenantId, context.runId);
    if (!runState) {
      await emitStepError(
        args,
        'SCHEDULE_SELF_UNRESOLVED',
        'target: "self" requires a running session with a resolved target',
        startTime,
        'validation',
      );
      return;
    }
    if (runState.target.kind === 'inline-agent') {
      await emitStepError(
        args,
        'SCHEDULE_INLINE_NOT_SCHEDULABLE',
        'Inline-agent runs cannot create schedules (target.kind = "inline-agent").',
        startTime,
        'validation',
      );
      return;
    }
    target = runState.target;
  } else if (rawTarget !== undefined && rawTarget !== null) {
    const parse = PersistentAgentTargetSchema.safeParse(rawTarget);
    if (!parse.success) {
      await emitStepError(
        args,
        'SCHEDULE_INVALID_TARGET',
        `Invalid target: ${parse.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        startTime,
        'validation',
      );
      return;
    }
    target = parse.data;
  }

  let targetRunId = input['targetRunId'] as string | undefined;
  if (targetRunId === 'self') {
    targetRunId = context.runId as string;
  }

  const action = (input['action'] as string) || 'start_run';

  // Action→target validation (schema superRefine handles this too, but belt-and-suspenders)
  if (action === 'start_run' && !target) {
    await emitStepError(
      args,
      'SCHEDULE_MISSING_FLOW',
      'target is required for start_run.',
      startTime,
      'validation',
    );
    return;
  }
  if (action === 'resume_run' && !targetRunId) {
    await emitStepError(
      args,
      'SCHEDULE_MISSING_RUN',
      'targetRunId is required for resume_run.',
      startTime,
      'validation',
    );
    return;
  }

  // --- Validate timezone ---
  const timezone = (input['timezone'] ?? 'UTC') as string;
  if (!isValidTimezone(timezone)) {
    await emitStepError(
      args,
      'SCHEDULE_INVALID_TIMEZONE',
      `Invalid timezone: ${timezone}`,
      startTime,
      'validation',
    );
    return;
  }

  // --- Validate cron expression + rate limit ---
  let cronExpression: string | undefined;
  if (hasCron) {
    cronExpression = input['cron'] as string;
    const cronError = validateCronExpression(cronExpression);
    if (cronError) {
      await emitStepError(
        args,
        'SCHEDULE_INVALID_CRON',
        `Invalid cron expression: ${cronError}`,
        startTime,
        'validation',
      );
      return;
    }

    // Reject cron faster than 1/min
    const effectiveInterval = getCronMinIntervalSeconds(cronExpression, timezone);
    if (effectiveInterval !== null && effectiveInterval < MIN_CRON_INTERVAL_SECONDS) {
      await emitStepError(
        args,
        'SCHEDULE_CRON_TOO_FAST',
        `Cron expression fires more than once per minute. Minimum interval is ${String(MIN_CRON_INTERVAL_SECONDS)} seconds.`,
        startTime,
        'validation',
      );
      return;
    }
  }

  // --- Validate one-shot horizon ---
  if (kind === 'one_shot') {
    const scheduledDate = new Date(input['scheduledAt'] as string);
    const maxHorizon = new Date();
    maxHorizon.setDate(maxHorizon.getDate() + ONE_SHOT_MAX_HORIZON_DAYS);
    if (scheduledDate > maxHorizon) {
      await emitStepError(
        args,
        'SCHEDULE_TOO_FAR_FUTURE',
        `One-shot schedule cannot be more than ${String(ONE_SHOT_MAX_HORIZON_DAYS)} days in the future.`,
        startTime,
        'validation',
      );
      return;
    }
  }

  // --- maxFirings guardrails ---
  let maxFirings = input['maxFirings'] as number | undefined;
  if (kind === 'one_shot') {
    maxFirings = 1; // Always 1 for one-shot
  } else {
    // cron / on_completion: a firing-count backstop. Absent → the safe cap;
    // over the cap → clamped. expiresAt is the independent time bound.
    if (maxFirings === undefined) maxFirings = MAX_FIRINGS_CAP;
    if (maxFirings > MAX_FIRINGS_CAP) maxFirings = MAX_FIRINGS_CAP;
  }

  // --- Compute next_fire_at ---
  let nextFireAt: Date | null = null;
  if (kind === 'cron' && cronExpression) {
    const next = getNextCronFireTime(cronExpression, timezone);
    if (next) nextFireAt = new Date(next);
  } else if (kind === 'one_shot') {
    nextFireAt = new Date(input['scheduledAt'] as string);
  }

  // --- Resolve on_completion config ---
  let sourceTarget: PersistentAgentTarget | undefined;
  let sourceStatus: string | undefined;
  if (hasOnComplete) {
    const onComplete = input['onFlowComplete'] as Record<string, unknown>;
    const rawSource = onComplete['target'];
    if (rawSource === 'self') {
      const runState = await getSessionState(args.redis, context.tenantId, context.runId);
      if (!runState || runState.target.kind === 'inline-agent') {
        await emitStepError(
          args,
          'SCHEDULE_SELF_UNRESOLVED',
          'onFlowComplete.target: "self" requires a running persistent (non-inline) session.',
          startTime,
          'validation',
        );
        return;
      }
      sourceTarget = runState.target;
    } else if (rawSource !== undefined && rawSource !== null) {
      const parse = PersistentAgentTargetSchema.safeParse(rawSource);
      if (!parse.success) {
        await emitStepError(
          args,
          'SCHEDULE_INVALID_SOURCE_TARGET',
          `Invalid onFlowComplete.target: ${parse.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          startTime,
          'validation',
        );
        return;
      }
      sourceTarget = parse.data;
    }
    sourceStatus = (onComplete['status'] ?? 'succeeded') as string;

    // Cycle detection: reject if source target == target (compare by stable key)
    if (target && sourceTarget && agentTargetKey(target) === agentTargetKey(sourceTarget)) {
      await emitStepError(
        args,
        'SCHEDULE_CYCLE_DETECTED',
        'Cannot create an on_completion schedule where source target equals target — would loop.',
        startTime,
        'validation',
      );
      return;
    }

    // Extended cycle detection: check the inverse schedule doesn't already exist.
    //    Compare tagged columns directly: source-of-the-existing matches our
    //    target, and target-of-the-existing matches our source.
    if (target && sourceTarget) {
      const db = getDatabase();
      const tenantCtx = createTenantContext(context.tenantId);
      // Persistent-target only: schedules never carry inline-agent. Narrow.
      type ScheduleTargetKind = 'platform-role' | 'custom-agent';
      const tCols = targetToColumns(target) as {
        targetKind: ScheduleTargetKind;
        targetSystemRole: string | null;
        targetAgentId: string | null;
        targetInlineDefRef: null;
      };
      const sCols = targetToColumns(sourceTarget) as {
        targetKind: ScheduleTargetKind;
        targetSystemRole: string | null;
        targetAgentId: string | null;
        targetInlineDefRef: null;
      };
      const reverseConds = [
        eq(agentSchedules.kind, 'on_completion'),
        eq(agentSchedules.status, 'active'),
        eq(agentSchedules.spaceId, spaceId),
        // existing.source == our target
        eq(agentSchedules.sourceKind, tCols.targetKind),
        tCols.targetKind === 'platform-role'
          ? eq(agentSchedules.sourceSystemRole, tCols.targetSystemRole!)
          : eq(agentSchedules.sourceAgentId, tCols.targetAgentId!),
        // existing.target == our source
        eq(agentSchedules.targetKind, sCols.targetKind),
        sCols.targetKind === 'platform-role'
          ? eq(agentSchedules.targetSystemRole, sCols.targetSystemRole!)
          : eq(agentSchedules.targetAgentId, sCols.targetAgentId!),
      ];
      const reverseSchedules = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx
          .select({ id: agentSchedules.id })
          .from(agentSchedules)
          .where(and(...reverseConds))
          .limit(1);
      });
      if (reverseSchedules.length > 0) {
        await emitStepError(
          args,
          'SCHEDULE_CYCLE_DETECTED',
          `An active on_completion schedule already exists from "${agentTargetKey(target)}" to "${agentTargetKey(sourceTarget)}". Adding this schedule would create a cycle.`,
          startTime,
          'validation',
        );
        return;
      }
    }
  }

  // --- Auto-compute expiresAt for recurring schedules ---
  const scheduledAt = hasScheduledAt ? new Date(input['scheduledAt'] as string) : null;
  let expiresAt = input['expiresAt'] ? new Date(input['expiresAt'] as string) : null;
  if (!expiresAt && kind === 'cron') {
    expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + DEFAULT_RECURRING_EXPIRY_DAYS);
  }

  const grant = await getRunAccessGrant(args.redis, context.tenantId, context.runId);
  if (!grant) {
    await emitStepError(
      args,
      'SCHEDULE_NO_CREDENTIAL_OWNER',
      'Schedules run as their creator, and this session has no user identity to inherit — ' +
        'a run started by this schedule would fail as soon as it needs credentials. ' +
        'Create the schedule from a session started by a user.',
      startTime,
      'validation',
    );
    return;
  }

  // --- Insert ---
  const db = getDatabase();
  const tenantCtx = createTenantContext(context.tenantId);

  interface ScheduleTargetCols {
    targetKind: 'platform-role' | 'custom-agent' | null;
    targetSystemRole: string | null;
    targetAgentId: string | null;
  }
  const targetCols: ScheduleTargetCols = target
    ? (targetToColumns(target) as ScheduleTargetCols)
    : { targetKind: null, targetSystemRole: null, targetAgentId: null };
  const sourceCols = sourceTarget ? (targetToColumns(sourceTarget) as ScheduleTargetCols) : null;

  const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
    return tx
      .insert(agentSchedules)
      .values({
        spaceId,
        name: input['name'] as string,
        description: (input['description'] as string | undefined) ?? null,
        action,
        targetKind: targetCols.targetKind,
        targetSystemRole: targetCols.targetSystemRole,
        targetAgentId: targetCols.targetAgentId,
        agentVersion: (input['flowVersion'] as string | undefined) ?? null,
        targetSessionId: targetRunId ?? null,
        targetStepExecutionId: null,
        kind,
        cronExpression: cronExpression ?? null,
        timezone,
        scheduledAt,
        ...(sourceCols
          ? {
              sourceKind: sourceCols.targetKind,
              sourceSystemRole: sourceCols.targetSystemRole,
              sourceAgentId: sourceCols.targetAgentId,
            }
          : {}),
        sourceStatus: sourceStatus ?? null,
        inputTemplate: scheduleInput,
        status: 'active',
        maxFirings: (maxFirings as number | undefined) ?? null,
        firingCount: 0,
        nextFireAt,
        expiresAt,
        lastError: null,
        createdBy:
          typeof context.agentDefinition.metadata.custom['createdBy'] === 'string'
            ? context.agentDefinition.metadata.custom['createdBy']
            : null,
        createdBySessionId: context.runId as string,
        metadata: (input['metadata'] ?? {}) as Record<string, unknown>,
        creatorUserId: grant.grantedToUserId,
        creatorTenantRole: grant.tenantRole,
        creatorSpaceRole: grant.spaceRole,
      })
      .returning({
        id: agentSchedules.id,
        name: agentSchedules.name,
        kind: agentSchedules.kind,
        status: agentSchedules.status,
        maxFirings: agentSchedules.maxFirings,
        nextFireAt: agentSchedules.nextFireAt,
        expiresAt: agentSchedules.expiresAt,
        createdAt: agentSchedules.createdAt,
      });
  });

  const row = rows[0];
  if (!row) {
    await emitStepError(
      args,
      'SCHEDULE_INSERT_FAILED',
      'Failed to insert schedule',
      startTime,
      'internal',
    );
    return;
  }

  // The Action Center reads schedules from the database, so a connected client
  // learns about this one only when something wakes its topic. Nothing else on
  // this path does, and an operator who is already looking at the space is
  // exactly the person the notice is for — without this it arrives on the next
  // reconnect, which reads as the platform having kept it quiet.
  try {
    const { appendEntityEvent } = await import('@aflow/redis');
    await appendEntityEvent(args.redis, {
      tenantId: context.tenantId,
      spaceId,
      event: {
        eventId: randomUUID(),
        eventType: 'entity.schedule.armed',
        spaceId,
        tenantId: context.tenantId,
        timestamp: Date.now(),
        causedBySessionId: context.runId,
        causedByStepExecutionId: args.stepExecutionId,
        payload: { scheduleId: row.id, kind: row.kind },
        summary: `Scheduled "${row.name}"`,
      },
    });
  } catch (err) {
    // A schedule that exists and was not announced is recoverable on the next
    // wake; failing the step that created it is not.
    getOrchestratorLogger().warn('[scheduleCrud] armed-event publish failed', {
      err,
      scheduleId: row.id,
    });
  }

  await emitStepSuccess(
    args,
    {
      scheduleId: row.id,
      name: row.name,
      kind: row.kind,
      status: row.status,
      maxFirings: row.maxFirings,
      nextFireAt: row.nextFireAt ? row.nextFireAt.toISOString() : null,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    },
    startTime,
  );
}

// ============================================================================
// agent.schedule.get
// ============================================================================

async function handleGet(
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

  const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
    return tx
      .select()
      .from(agentSchedules)
      .where(and(eq(agentSchedules.id, scheduleId), eq(agentSchedules.spaceId, spaceId)))
      .limit(1);
  });

  const row = rows[0];
  if (!row) {
    await emitStepError(
      args,
      'SCHEDULE_NOT_FOUND',
      `Schedule ${scheduleId} not found.`,
      startTime,
      'not_found',
    );
    return;
  }

  await emitStepSuccess(args, rowToSchedule(row), startTime);
}

// ============================================================================
// agent.schedule.list
// ============================================================================

async function handleList(
  args: InlineHandlerArgs,
  input: Record<string, unknown>,
  startTime: number,
): Promise<void> {
  const { context } = args;
  const spaceId = requireSpaceId(context);

  const limit = Math.min(Math.max(Number(input['limit']) || 20, 1), 100);
  const db = getDatabase();
  const tenantCtx = createTenantContext(context.tenantId);

  const conditions = [eq(agentSchedules.spaceId, spaceId)];

  if (input['status'] && typeof input['status'] === 'string') {
    conditions.push(eq(agentSchedules.status, input['status']));
  } else {
    conditions.push(sql`${agentSchedules.status} != 'deleted'`);
  }
  const filterTargetRaw = input['target'];
  if (filterTargetRaw && typeof filterTargetRaw === 'object') {
    const filterParse = PersistentAgentTargetSchema.safeParse(filterTargetRaw);
    if (filterParse.success) {
      const filterCols = targetToColumns(filterParse.data) as {
        targetKind: 'platform-role' | 'custom-agent';
        targetSystemRole: string | null;
        targetAgentId: string | null;
      };
      conditions.push(eq(agentSchedules.targetKind, filterCols.targetKind));
      if (filterCols.targetKind === 'platform-role') {
        conditions.push(eq(agentSchedules.targetSystemRole, filterCols.targetSystemRole!));
      } else {
        conditions.push(eq(agentSchedules.targetAgentId, filterCols.targetAgentId!));
      }
    }
  }
  if (input['kind'] && typeof input['kind'] === 'string') {
    conditions.push(eq(agentSchedules.kind, input['kind']));
  }
  if (input['createdByRunId'] && typeof input['createdByRunId'] === 'string') {
    conditions.push(eq(agentSchedules.createdBySessionId, input['createdByRunId']));
  }

  const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
    return tx
      .select()
      .from(agentSchedules)
      .where(and(...conditions))
      .orderBy(desc(agentSchedules.createdAt))
      .limit(limit + 1);
  });

  const hasMore = rows.length > limit;
  const schedules = (hasMore ? rows.slice(0, limit) : rows).map(rowToSchedule);

  await emitStepSuccess(
    args,
    {
      schedules,
      nextCursor: hasMore ? schedules[schedules.length - 1]?.['id'] : null,
      totalCount: schedules.length,
    },
    startTime,
  );
}

// ============================================================================
// agent.schedule.update
// ============================================================================

async function handleUpdate(
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

// ============================================================================
// agent.schedule.delete
// ============================================================================

async function handleDelete(
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

  const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
    return tx
      .update(agentSchedules)
      .set({ status: 'deleted', updatedAt: new Date() })
      .where(and(eq(agentSchedules.id, scheduleId), eq(agentSchedules.spaceId, spaceId)))
      .returning({ id: agentSchedules.id });
  });

  if (rows.length === 0) {
    await emitStepError(
      args,
      'SCHEDULE_NOT_FOUND',
      `Schedule ${scheduleId} not found in this space.`,
      startTime,
      'not_found',
    );
    return;
  }

  await emitStepSuccess(args, { scheduleId, deleted: true }, startTime);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Estimate the minimum interval between cron firings in seconds.
 * Returns null if unable to compute (fallback: allow).
 */
function getCronMinIntervalSeconds(expression: string, timezone: string): number | null {
  try {
    const job = new Cron(expression, { timezone });
    const first = job.nextRun();
    if (!first) {
      job.stop();
      return null;
    }
    const second = job.nextRun(new Date(first.getTime() + 1000));
    job.stop();
    if (!second) return null;
    return (second.getTime() - first.getTime()) / 1000;
  } catch {
    return null;
  }
}

function rowToSchedule(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row['id'],
    spaceId: row['spaceId'],
    name: row['name'],
    description: row['description'] ?? null,
    action: row['action'],
    flowId: row['flowId'] ?? null,
    flowVersion: row['flowVersion'] ?? null,
    targetRunId: row['targetRunId'] ?? null,
    kind: row['kind'],
    cronExpression: row['cronExpression'] ?? null,
    timezone: row['timezone'],
    scheduledAt: row['scheduledAt'] ? (row['scheduledAt'] as Date).toISOString() : null,
    sourceFlowId: row['sourceFlowId'] ?? null,
    sourceStatus: row['sourceStatus'] ?? null,
    inputTemplate: row['inputTemplate'] ?? {},
    status: row['status'],
    maxFirings: row['maxFirings'] ?? null,
    firingCount: row['firingCount'],
    lastFiredAt: row['lastFiredAt'] ? (row['lastFiredAt'] as Date).toISOString() : null,
    lastRunId: row['lastRunId'] ?? null,
    nextFireAt: row['nextFireAt'] ? (row['nextFireAt'] as Date).toISOString() : null,
    expiresAt: row['expiresAt'] ? (row['expiresAt'] as Date).toISOString() : null,
    lastError: row['lastError'] ?? null,
    createdBy: row['createdBy'] ?? null,
    createdByRunId: row['createdByRunId'] ?? null,
    metadata: row['metadata'] ?? {},
    createdAt: row['createdAt'] ? (row['createdAt'] as Date).toISOString() : null,
    updatedAt: row['updatedAt'] ? (row['updatedAt'] as Date).toISOString() : null,
  };
}
