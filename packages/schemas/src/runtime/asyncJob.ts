/**
 * Durable lifecycle for a provider-side asynchronous job.
 *
 * A long render, transcode, or generation is accepted by a provider in one call
 * and completed minutes later. The dangerous edge is not the wait — it is the
 * window between the provider accepting the work and this side recording that
 * it did. A crash there leaves no evidence a call happened, and a naive replay
 * buys the same paid job twice.
 */
import { z } from 'zod';

/**
 * `submitting` is written BEFORE the provider call, so a replay always finds
 * evidence that a call may have happened. `unknown` is the honest terminal for
 * a route that cannot prove otherwise: work may or may not exist upstream, and
 * automation must never resolve that ambiguity by paying again.
 */
export const AsyncJobStateSchema = z.enum([
  'reserved',
  'submitting',
  'submitted',
  'polling',
  'succeeded',
  'failed',
  'unknown',
]);
export type AsyncJobState = z.infer<typeof AsyncJobStateSchema>;

export const ASYNC_JOB_TERMINAL_STATES = ['succeeded', 'failed', 'unknown'] as const;

export function isAsyncJobTerminal(state: AsyncJobState): boolean {
  return (ASYNC_JOB_TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * What a route can promise about a replayed submit. This is a description of a
 * mechanism, not an assertion of idempotence — a boolean `idempotent: true`
 * would be a claim nobody could check, and the whole point is that the two
 * cases recover differently.
 */
export const AsyncReplayGuaranteeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('idempotency_key'),
    /** Request field or header carrying our deterministic client request id. */
    field: z.string().min(1).max(128),
  }),
  z.object({ kind: z.literal('unknown_terminal') }),
]);
export type AsyncReplayGuarantee = z.infer<typeof AsyncReplayGuaranteeSchema>;

/**
 * What a worker must do on observing a persisted job. Recovery is a pure
 * function of state and guarantee so it can be unit-tested without a provider.
 */
export const AsyncJobRecoveryActionSchema = z.enum([
  'submit',
  'resubmit_deduped',
  'poll',
  'mark_unknown',
  'complete',
]);
export type AsyncJobRecoveryAction = z.infer<typeof AsyncJobRecoveryActionSchema>;

export function resolveAsyncJobRecovery(
  state: AsyncJobState,
  guarantee: AsyncReplayGuarantee,
): AsyncJobRecoveryAction {
  switch (state) {
    case 'reserved':
      return 'submit';
    // The ambiguous edge. With a provider-side dedupe key a replay is safe and
    // returns the original job; without one, paying again is the only other
    // option, so the job is stranded deliberately rather than silently retried.
    case 'submitting':
      return guarantee.kind === 'idempotency_key' ? 'resubmit_deduped' : 'mark_unknown';
    case 'submitted':
    case 'polling':
      return 'poll';
    // Listed rather than defaulted: a state added later must fail the build,
    // not fall silently into 'complete'.
    case 'succeeded':
    case 'failed':
    case 'unknown':
      return 'complete';
  }
}

/**
 * The immutable half of a job: the facts that decide whether two submissions are
 * the same work. `attempt` is part of it — a legitimate new attempt must be able
 * to buy a new job, while a replay of that same attempt must find the prior one.
 *
 * `logicalExecutionId` is the caller's stable handle for the unit of work, not a
 * volatile `stepExecutionId`: a workflow task's retry mints a fresh step id for
 * work that is unchanged, and keying on it would buy the render twice.
 */
export const AsyncJobIdentitySchema = z.object({
  runId: z.string().min(1),
  logicalExecutionId: z.string().min(1).max(200),
  attempt: z.number().int().nonnegative(),
  operationId: z.string().min(1),
  provider: z.string().min(1).max(64),
  model: z.string().max(128).optional(),
  inputHash: z.string().min(1).max(128),
});
export type AsyncJobIdentity = z.infer<typeof AsyncJobIdentitySchema>;

/** The fields a conflicting reservation must match to be the same work. */
export const ASYNC_JOB_IDENTITY_FIELDS = [
  'runId',
  'logicalExecutionId',
  'attempt',
  'operationId',
  'provider',
  'model',
  'inputHash',
] as const satisfies ReadonlyArray<keyof AsyncJobIdentity>;

/**
 * One derivation, used by every caller. A caller-composed key would let two
 * different pieces of work collide on one row, and the conflict path would
 * hand back somebody else's provider job.
 */
export function deriveAsyncJobKey(identity: AsyncJobIdentity): string {
  const parsed = AsyncJobIdentitySchema.parse(identity);
  return [
    parsed.runId,
    parsed.logicalExecutionId,
    String(parsed.attempt),
    parsed.operationId,
    parsed.provider,
    parsed.model ?? '',
    parsed.inputHash,
  ].join('|');
}

/** Sent to providers that dedupe on it; stable across replays of one attempt. */
export function deriveClientRequestId(identity: AsyncJobIdentity): string {
  return deriveAsyncJobKey(identity);
}

/**
 * Money is a currency plus integer minor-of-minor units. Providers bill in
 * different units and floating point does not reconcile.
 */
export const AsyncJobCostSchema = z.object({
  currency: z.string().length(3),
  micros: z.number().int().nonnegative(),
});
export type AsyncJobCost = z.infer<typeof AsyncJobCostSchema>;

export const AsyncJobRecordSchema = z.object({
  /** Deterministic across replays of the same work — never a fresh uuid. */
  jobKey: z.string().min(1).max(200),
  runId: z.string(),
  logicalExecutionId: z.string(),
  attempt: z.number().int().nonnegative(),
  operationId: z.string(),
  provider: z.string().min(1).max(64),
  model: z.string().max(128).optional(),
  state: AsyncJobStateSchema,
  replayGuarantee: AsyncReplayGuaranteeSchema,
  /** Sent to the provider when the guarantee is `idempotency_key`. */
  clientRequestId: z.string().min(1).max(200),
  /** Hash of the resolved request, so a changed input is a different job. */
  inputHash: z.string().min(1).max(128),
  providerJobId: z.string().max(256).optional(),
  pollCount: z.number().int().nonnegative().default(0),
  lastError: z.string().max(2000).optional(),
  actualCost: AsyncJobCostSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AsyncJobRecord = z.infer<typeof AsyncJobRecordSchema>;
