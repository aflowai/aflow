import { pgTable, text, integer, bigint, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AsyncJobState, AsyncReplayGuarantee } from '@aflow/schemas';

// ============================================================================

/**
 * Durable lifecycle of a provider-side asynchronous job. `job_key` is
 * deterministic across replays of the same work, so a crash between the
 * provider accepting a job and this side recording it finds the earlier row
 * instead of paying for the job twice.
 */
export const asyncJobs = pgTable(
  'async_jobs',
  {
    jobKey: text('job_key').primaryKey(),
    runId: text('run_id').notNull(),
    /**
     * The unit of work, which is not always the step execution the column is
     * named after: a workflow task keeps this handle across a retry that
     * dispatches it under a new worker session.
     */
    logicalExecutionId: text('step_execution_id').notNull(),
    attempt: integer('attempt').notNull().default(0),
    operationId: text('operation_id').notNull(),
    provider: text('provider').notNull(),
    model: text('model'),
    state: text('state').notNull().$type<AsyncJobState>(),
    replayGuarantee: jsonb('replay_guarantee').notNull().$type<AsyncReplayGuarantee>(),
    /** Sent to the provider when the guarantee is `idempotency_key`. */
    clientRequestId: text('client_request_id').notNull(),
    /** Hash of the resolved request, so a changed input is a different job. */
    inputHash: text('input_hash').notNull(),
    providerJobId: text('provider_job_id'),
    pollCount: integer('poll_count').notNull().default(0),
    lastError: text('last_error'),
    costCurrency: text('cost_currency'),
    costMicros: bigint('cost_micros', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_async_jobs_step').on(table.runId, table.logicalExecutionId, table.attempt),
    index('idx_async_jobs_live')
      .on(table.state)
      .where(sql`${table.state} IN ('submitting','submitted','polling')`),
  ],
);

export type AsyncJobRow = typeof asyncJobs.$inferSelect;
export type NewAsyncJobRow = typeof asyncJobs.$inferInsert;
