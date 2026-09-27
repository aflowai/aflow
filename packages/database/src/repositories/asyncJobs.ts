/**
 * Durable lifecycle rows for provider-side async jobs.
 *
 * Every mutating statement is a compare-and-set: it names the states it may
 * advance from and reports whether it matched. Two workers routinely observe
 * the same job — an orchestrator retry racing a poll drain — and a blind UPDATE
 * would let both believe they own the transition. For work a provider bills on
 * submit, that is a second paid job.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  type ASYNC_JOB_TERMINAL_STATES,
  ASYNC_JOB_IDENTITY_FIELDS,
  AsyncJobIdentitySchema,
  AsyncJobRecordSchema,
  deriveAsyncJobKey,
  deriveClientRequestId,
  type AsyncJobIdentity,
  type AsyncReplayGuarantee,
  AsyncJobStateSchema,
  isAsyncJobTerminal,
  type AsyncJobCost,
  type AsyncJobRecord,
  type AsyncJobState,
} from '@aflow/schemas';
import type { TenantContext } from '../tenant.js';
import { withTenantSchema } from '../tenant.js';
import { asyncJobs, type AsyncJobRow } from '../schema/tenant.js';

export type AsyncJobTerminalState = (typeof ASYNC_JOB_TERMINAL_STATES)[number];

/** A state a job can still be advanced out of. Settled results are never rewritten. */
export type AsyncJobLiveState = Exclude<AsyncJobState, AsyncJobTerminalState>;

/** `submitting` is a legal predecessor of itself: a deduped replay re-submits. */
export type AsyncJobSubmitPredecessor = Extract<AsyncJobState, 'reserved' | 'submitting'>;

const POLL_PREDECESSORS = ['submitted', 'polling'] as const satisfies readonly AsyncJobState[];

const NON_TERMINAL_STATES: AsyncJobLiveState[] = AsyncJobStateSchema.options.filter(
  (state): state is AsyncJobLiveState => !isAsyncJobTerminal(state),
);

/**
 * A provider call has been made, or may have been made. Kept identical to the
 * partial index predicate on `async_jobs (state)` — a wider filter still
 * returns the right rows but silently stops using the index.
 */
export const ASYNC_JOB_IN_FLIGHT_STATES: AsyncJobState[] = NON_TERMINAL_STATES.filter(
  (state) => state !== 'reserved',
);

const LAST_ERROR_MAX = AsyncJobRecordSchema.shape.lastError.unwrap().maxLength ?? 2000;

function clampLastError(value: string | undefined): string | null {
  if (value === undefined) return null;
  return value.length > LAST_ERROR_MAX ? value.slice(0, LAST_ERROR_MAX) : value;
}

/**
 * Identity plus the guarantee the resolved route actually offered. Everything
 * else is lifecycle the repository owns, and `jobKey`/`clientRequestId` are
 * derived rather than accepted — a caller-composed key would let two different
 * pieces of work collide on one row.
 */
export interface AsyncJobReservation {
  identity: AsyncJobIdentity;
  replayGuarantee: AsyncReplayGuarantee;
}

/** A conflicting key whose row is not the same work. Never resolvable by retry. */
export class AsyncJobIdentityMismatchError extends Error {
  constructor(
    readonly jobKey: string,
    readonly field: string,
  ) {
    super(`Async job '${jobKey}' already exists with a different ${field}`);
    this.name = 'AsyncJobIdentityMismatchError';
  }
}

export interface AsyncJobReserveResult {
  record: AsyncJobRecord;
  /** False when the key was already present — the record is then the prior one. */
  created: boolean;
}

export interface AsyncJobTerminalOptions {
  lastError?: string;
  actualCost?: AsyncJobCost;
  /**
   * The states this transition may advance from. A caller that decided from an
   * earlier read must name what it read: the row can have moved on since, and
   * settling it anyway abandons a render another worker is still polling.
   * Defaults to every live state, which only a decision made from a provider's
   * own verdict may rely on.
   */
  expectedStates?: readonly AsyncJobLiveState[];
}

// Reconciliation's own predecessor is fixed at `unknown`, so naming one here
// would be an option with nothing to do.
export interface AsyncJobReconcileOptions extends Omit<AsyncJobTerminalOptions, 'expectedStates'> {
  /** Who resolved it — a person or the listing sweep. Never an executor. */
  reconciledBy: string;
  providerJobId?: string;
}

export interface AsyncJobRepository {
  /**
   * The idempotency anchor. The same work derives the same `jobKey`, so a
   * replay observes the prior row instead of creating a second paid job.
   */
  reserveJob(input: AsyncJobReservation): Promise<AsyncJobReserveResult>;
  markSubmitting(jobKey: string, expectedState: AsyncJobSubmitPredecessor): Promise<boolean>;
  markSubmitted(jobKey: string, providerJobId: string): Promise<boolean>;
  recordPoll(jobKey: string): Promise<boolean>;
  markTerminal(
    jobKey: string,
    state: AsyncJobTerminalState,
    opts?: AsyncJobTerminalOptions,
  ): Promise<boolean>;
  /**
   * Operator/reconciler-only. `unknown` is terminal for automation, but the work
   * may exist upstream — this is how a discovered job id, cost and outcome get
   * attached once a human or a provider listing has resolved it. Guarded to
   * `unknown` so it can never overwrite a settled result, and deliberately not
   * reachable from any automated path.
   */
  reconcileUnknownJob(
    jobKey: string,
    outcome: Exclude<AsyncJobTerminalState, 'unknown'>,
    opts: AsyncJobReconcileOptions,
  ): Promise<boolean>;
  getJob(jobKey: string): Promise<AsyncJobRecord | null>;
  /**
   * Scoped to the unit of work, not the attempt: `jobKey` is frozen at first
   * insert, so a stored `attempt` goes stale on retry — the one moment
   * discovery matters. Whatever a caller reserved under is what it must look
   * up under, or a retry stops finding the work it already paid for.
   */
  listLiveJobsForExecution(runId: string, logicalExecutionId: string): Promise<AsyncJobRecord[]>;
}

export function toAsyncJobRecord(row: AsyncJobRow): AsyncJobRecord {
  // cost_micros is a bigint and reaches the driver as text; the column's number
  // mode is what narrows it, so money never enters the record as a string.
  const actualCost =
    row.costCurrency !== null && row.costMicros !== null
      ? { currency: row.costCurrency, micros: row.costMicros }
      : undefined;
  // The row's state and guarantee are unvalidated casts over text and jsonb;
  // parsing is what makes them the contract the rest of the lane relies on.
  return AsyncJobRecordSchema.parse({
    jobKey: row.jobKey,
    runId: row.runId,
    logicalExecutionId: row.logicalExecutionId,
    attempt: row.attempt,
    operationId: row.operationId,
    provider: row.provider,
    ...(row.model !== null ? { model: row.model } : {}),
    state: row.state,
    replayGuarantee: row.replayGuarantee,
    clientRequestId: row.clientRequestId,
    inputHash: row.inputHash,
    ...(row.providerJobId !== null ? { providerJobId: row.providerJobId } : {}),
    pollCount: row.pollCount,
    ...(row.lastError !== null ? { lastError: row.lastError } : {}),
    ...(actualCost !== undefined ? { actualCost } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * Every method owns a short transaction of its own, and there is deliberately no
 * way to run one inside an ambient transaction.
 *
 * The lifecycle's whole guarantee is that `submitting` is DURABLE before the
 * provider call. A caller holding an outer transaction could write `submitting`,
 * call the provider, then roll back — leaving paid work upstream and no record
 * that it was ever requested, which is precisely the window this exists to
 * close. Short transactions also keep the run-row and job-row locks from being
 * held across a network call.
 */
export function createAsyncJobRepository(
  db: PostgresJsDatabase,
  tenantContext: TenantContext,
): AsyncJobRepository {
  const run = <T>(fn: (tx: PostgresJsDatabase) => Promise<T>): Promise<T> =>
    withTenantSchema(db, tenantContext, fn);

  return {
    async reserveJob(input) {
      const identity = AsyncJobIdentitySchema.parse(input.identity);
      const jobKey = deriveAsyncJobKey(identity);
      return run(async (tx) => {
        const [inserted] = await tx
          .insert(asyncJobs)
          .values({
            jobKey,
            runId: identity.runId,
            logicalExecutionId: identity.logicalExecutionId,
            attempt: identity.attempt,
            operationId: identity.operationId,
            provider: identity.provider,
            model: identity.model ?? null,
            state: 'reserved',
            replayGuarantee: input.replayGuarantee,
            clientRequestId: deriveClientRequestId(identity),
            inputHash: identity.inputHash,
          })
          .onConflictDoNothing({ target: asyncJobs.jobKey })
          .returning();
        if (inserted !== undefined) {
          return { record: toAsyncJobRecord(inserted), created: true };
        }
        const [existing] = await tx
          .select()
          .from(asyncJobs)
          .where(eq(asyncJobs.jobKey, jobKey))
          .limit(1);
        if (existing === undefined) {
          throw new Error(`Async job '${jobKey}' conflicted on insert but is not readable`);
        }
        // The key is derived, so a mismatch here means the derivation is not
        // total over identity — returning the row anyway would hand this caller
        // somebody else's provider job.
        const prior = toAsyncJobRecord(existing);
        const priorIdentity: AsyncJobIdentity = {
          runId: prior.runId,
          logicalExecutionId: prior.logicalExecutionId,
          attempt: prior.attempt,
          operationId: prior.operationId,
          provider: prior.provider,
          ...(prior.model !== undefined ? { model: prior.model } : {}),
          inputHash: prior.inputHash,
        };
        for (const field of ASYNC_JOB_IDENTITY_FIELDS) {
          if (priorIdentity[field] !== identity[field]) {
            throw new AsyncJobIdentityMismatchError(jobKey, field);
          }
        }
        return { record: prior, created: false };
      });
    },

    async markSubmitting(jobKey, expectedState) {
      return run(async (tx) => {
        // A `submitting → submitting` claim is a replay of a submit that may
        // already have reached the provider, so `state` alone is not mutually
        // exclusive: two workers would both match and both pay. Only a route
        // the provider dedupes may re-enter, and that fact lives on the row —
        // so it is part of the compare-and-set rather than caller discipline.
        const guard =
          expectedState === 'submitting'
            ? and(
                eq(asyncJobs.state, 'submitting'),
                sql`${asyncJobs.replayGuarantee}->>'kind' = 'idempotency_key'`,
              )
            : eq(asyncJobs.state, expectedState);
        const rows = await tx
          .update(asyncJobs)
          .set({ state: 'submitting', updatedAt: sql`now()` })
          .where(and(eq(asyncJobs.jobKey, jobKey), guard))
          .returning({ jobKey: asyncJobs.jobKey });
        return rows.length > 0;
      });
    },

    async markSubmitted(jobKey, providerJobId) {
      return run(async (tx) => {
        const rows = await tx
          .update(asyncJobs)
          .set({ state: 'submitted', providerJobId, updatedAt: sql`now()` })
          .where(and(eq(asyncJobs.jobKey, jobKey), eq(asyncJobs.state, 'submitting')))
          .returning({ jobKey: asyncJobs.jobKey });
        return rows.length > 0;
      });
    },

    async recordPoll(jobKey) {
      return run(async (tx) => {
        const rows = await tx
          .update(asyncJobs)
          .set({
            state: 'polling',
            pollCount: sql`${asyncJobs.pollCount} + 1`,
            updatedAt: sql`now()`,
          })
          .where(
            and(eq(asyncJobs.jobKey, jobKey), inArray(asyncJobs.state, [...POLL_PREDECESSORS])),
          )
          .returning({ jobKey: asyncJobs.jobKey });
        return rows.length > 0;
      });
    },

    async markTerminal(jobKey, state, opts) {
      const cost = opts?.actualCost;
      const predecessors = opts?.expectedStates ?? NON_TERMINAL_STATES;
      return run(async (tx) => {
        const rows = await tx
          .update(asyncJobs)
          .set({
            state,
            // Clamped on write because the read parses through
            // AsyncJobRecordSchema: a provider 500 with an HTML body would
            // otherwise commit a row that every later read throws on —
            // including reserveJob's conflict path, which is the idempotency
            // anchor. A truncated diagnostic beats an unreadable job.
            lastError: clampLastError(opts?.lastError),
            costCurrency: cost?.currency ?? null,
            costMicros: cost?.micros ?? null,
            updatedAt: sql`now()`,
          })
          .where(and(eq(asyncJobs.jobKey, jobKey), inArray(asyncJobs.state, [...predecessors])))
          .returning({ jobKey: asyncJobs.jobKey });
        return rows.length > 0;
      });
    },

    async reconcileUnknownJob(jobKey, outcome, opts) {
      const cost = opts.actualCost;
      return run(async (tx) => {
        const rows = await tx
          .update(asyncJobs)
          .set({
            state: outcome,
            lastError: clampLastError(opts.lastError ?? `reconciled by ${opts.reconciledBy}`),
            ...(opts.providerJobId !== undefined ? { providerJobId: opts.providerJobId } : {}),
            costCurrency: cost?.currency ?? null,
            costMicros: cost?.micros ?? null,
            updatedAt: sql`now()`,
          })
          // Only an ambiguous job may be reconciled: a settled result is never
          // rewritten, and nothing that already knows its outcome is touched.
          .where(and(eq(asyncJobs.jobKey, jobKey), eq(asyncJobs.state, 'unknown')))
          .returning({ jobKey: asyncJobs.jobKey });
        return rows.length > 0;
      });
    },

    async getJob(jobKey) {
      return run(async (tx) => {
        const [row] = await tx
          .select()
          .from(asyncJobs)
          .where(eq(asyncJobs.jobKey, jobKey))
          .limit(1);
        return row === undefined ? null : toAsyncJobRecord(row);
      });
    },

    async listLiveJobsForExecution(runId, logicalExecutionId) {
      return run(async (tx) => {
        const rows = await tx
          .select()
          .from(asyncJobs)
          .where(
            and(
              eq(asyncJobs.runId, runId),
              eq(asyncJobs.logicalExecutionId, logicalExecutionId),
              inArray(asyncJobs.state, ASYNC_JOB_IN_FLIGHT_STATES),
            ),
          )
          .orderBy(asc(asyncJobs.createdAt));
        return rows.map(toAsyncJobRecord);
      });
    },
  };
}
