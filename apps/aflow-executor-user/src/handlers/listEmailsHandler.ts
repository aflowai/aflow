/**
 * Handler for user.notification.list_emails — lists emails sent to the current user.
 *
 * Queries the event_log (not step_executions) for StepSucceeded events with
 * operationId = 'user.notification.send_email', scoped to the current user
 * via sessions.createdBy.
 *
 * This pattern (event_log + operationId + createdBy join) is reusable for any
 * operation-scoped history query (e.g., list generated plans, content, etc.).
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { successWithData, failureWithError } from '@aflow/executor-runtime';
import {
  UserListEmailsInputSchema,
  type UserListEmailsOutput,
  type SentEmailSummary,
  type AflowError,
} from '@aflow/schemas';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, desc, lt } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { getSessionStateSafe } from '@aflow/redis';
import { eventLog, sessions, withTenantSchema, createTenantContext } from '@aflow/database';

export interface ListEmailsDeps {
  redis: Redis;
  db: PostgresJsDatabase;
}

export async function executeListEmails(
  ctx: ExecutorContext,
  deps: ListEmailsDeps,
): Promise<StepResult> {
  const { redis, db } = deps;
  const log = ctx.log;

  // 1. Parse input (with defaults)
  const rawInput = await ctx.readPayload(ctx.job.inputRef);
  const parsed = UserListEmailsInputSchema.safeParse(rawInput ?? {});

  if (!parsed.success) {
    return failureWithError(ctx, inputError(parsed.error.message));
  }

  const { limit, before } = parsed.data;

  // 2. Resolve current user from run hot state
  const runResult = await getSessionStateSafe(redis, ctx.tenantId, ctx.runId);
  const createdBy = runResult.ok ? runResult.state.createdBy : undefined;

  if (!createdBy) {
    return failureWithError(ctx, {
      code: 'CREATED_BY_MISSING',
      message: 'Cannot determine current user — run has no createdBy',
      classification: 'validation',
      retryable: false,
      timestamp: new Date().toISOString(),
    });
  }

  log.info('Listing sent emails', { userId: createdBy, limit, before });

  // 3. Query event_log joined with sessions
  //    Uses the partial index on (operation_id, timestamp DESC)
  //    WHERE event_type = 'StepSucceeded' AND operation_id IS NOT NULL
  const tenantContext = createTenantContext(ctx.tenantId);

  const rows = await withTenantSchema(db, tenantContext, async (tx) => {
    const conditions = [
      eq(eventLog.operationId, 'user.notification.send_email'),
      eq(eventLog.eventType, 'StepSucceeded'),
      eq(sessions.createdBy, createdBy),
    ];

    if (before) {
      conditions.push(lt(eventLog.timestamp, new Date(before)));
    }

    return tx
      .select({
        eventId: eventLog.eventId,
        stepExecutionId: eventLog.stepExecutionId,
        sessionId: eventLog.sessionId,
        payloadRef: eventLog.payloadRef,
        timestamp: eventLog.timestamp,
      })
      .from(eventLog)
      .innerJoin(sessions, eq(eventLog.sessionId, sessions.sessionId))
      .where(and(...conditions))
      .orderBy(desc(eventLog.timestamp))
      .limit(limit + 1); // fetch one extra to detect hasMore
  });

  // 4. Build summaries from output payloads
  const hasMore = rows.length > limit;
  const resultRows = hasMore ? rows.slice(0, limit) : rows;

  const emails: SentEmailSummary[] = [];

  for (const row of resultRows) {
    if (!row.payloadRef) continue;

    try {
      const raw = await ctx.readPayload(row.payloadRef);
      const output: Record<string, unknown> =
        typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

      const subject = typeof output['subject'] === 'string' ? output['subject'] : '(no subject)';
      const recipientEmail =
        typeof output['recipientEmail'] === 'string' ? output['recipientEmail'] : '';
      const contentFormat =
        output['contentFormat'] === 'html' || output['contentFormat'] === 'markdown'
          ? output['contentFormat']
          : 'markdown';
      const sentAt =
        typeof output['sentAt'] === 'string' ? output['sentAt'] : row.timestamp.toISOString();
      const messageId = typeof output['messageId'] === 'string' ? output['messageId'] : '';

      emails.push({
        stepExecutionId: row.stepExecutionId ?? row.eventId,
        runId: row.sessionId,
        subject,
        recipientEmail,
        contentFormat,
        sentAt,
        messageId,
      });
    } catch {
      log.warn('Failed to read output payload for event', {
        eventId: row.eventId,
      });
    }
  }

  const result: UserListEmailsOutput = {
    emails,
    totalReturned: emails.length,
    hasMore,
  };

  return successWithData(ctx, result);
}

function inputError(message: string): AflowError {
  return {
    code: 'EMAIL_LIST_INPUT_INVALID',
    message: `Invalid list_emails input: ${message}`,
    classification: 'validation',
    retryable: false,
    timestamp: new Date().toISOString(),
  };
}
