import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type { TenantId, Workflow } from '@aflow/schemas';
import { getRunAccessGrant, getSessionState } from '@aflow/redis';
import {
  GrantRenewalRefused,
  grantPrincipalSource,
  renewRunAccessGrant,
  resolveGrantRenewalSource,
} from '../../gates/grantRenewal.js';
import {
  checkWorkflowOperationGrantPreflight,
  type UngrantedWorkflowOperation,
} from './workflowCredentialsPreflight.js';

export type WorkflowGrantGateOutcome =
  | { kind: 'ok' }
  | { kind: 'ungranted'; ungrantedOperations: UngrantedWorkflowOperation[] }
  | { kind: 'authority_revoked'; detail: string }
  | { kind: 'authority_unavailable'; detail: string };

/**
 * Establish the authority a workflow run will execute under, then judge its
 * declared operations against it.
 *
 * Operation tasks are enqueued directly and never pass `scheduleStep`, so no
 * later gate recovers from an absent or stale grant established here.
 *
 * This is a START and RESUME-time check, not a complete one. Later dispatch
 * waves come from `taskComplete.ts` and the stale/orphan reconcilers, and
 * `retry_failed_task` returns before the resume gate — all reach
 * `dispatchTask`'s operation branch without revalidating, so an authority
 * narrowed AFTER this point can still dispatch an operation task. What this
 * buys is an early, resumable refusal naming the withheld capability; it is
 * not a substitute for enforcement at the dispatch boundary, which is
 * tracked in issue #809.
 *
 * The three null-grant cases are NOT interchangeable. A run whose grant
 * compilation failed still carries its established authority, and letting that
 * one through would run op tasks with no authority at all; a run started
 * without any actor context (schedules, system runs) has no authority to
 * establish and is ungated by design.
 */
export async function gateWorkflowOperationGrants(args: {
  db: PostgresJsDatabase;
  redis: Redis;
  tenantId: TenantId;
  /** The session whose actor context the run's grant compiles from. */
  sessionId: string;
  workflow: Workflow;
}): Promise<WorkflowGrantGateOutcome> {
  const { db, redis, tenantId, sessionId, workflow } = args;
  const stored = await getRunAccessGrant(redis, tenantId, sessionId);
  let grant = stored;

  if (stored) {
    // The stored copy can be up to its TTL stale in both directions, so an
    // operator who just performed the remediation a pause named is not held to
    // the old compile.
    try {
      grant = await renewRunAccessGrant(db, redis, {
        tenantId,
        runId: sessionId,
        source: grantPrincipalSource(stored),
      });
    } catch (err: unknown) {
      if (err instanceof GrantRenewalRefused) {
        return { kind: 'authority_revoked', detail: err.message };
      }
      // Judging against the stored copy would be fail-open here: op tasks face
      // no later gate, so a snapshot taken before the profile or ceiling was
      // narrowed would authorize a direct dispatch. A failed renewal means
      // current authority is unknown, which is not the same as unchanged.
      return {
        kind: 'authority_unavailable',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  } else {
    const runState = await getSessionState(redis, tenantId, sessionId);
    const source = resolveGrantRenewalSource(null, runState);
    if (source) {
      try {
        grant = await renewRunAccessGrant(db, redis, { tenantId, runId: sessionId, source });
      } catch (err: unknown) {
        return {
          kind: 'authority_unavailable',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  const result = checkWorkflowOperationGrantPreflight(grant, workflow);
  return result.ok
    ? { kind: 'ok' }
    : { kind: 'ungranted', ungrantedOperations: result.ungrantedOperations };
}

/**
 * Operator-facing text for a gate refusal on the RESUME path, naming the
 * operation and the remedy. Start writes its own: its refusals are about
 * whether the run may begin, not about an acknowledgement that will not take
 * effect — so the wording here is resume-specific by design.
 */
export function renderResumeGrantGateFailureMessage(
  slug: string,
  outcome: Exclude<WorkflowGrantGateOutcome, { kind: 'ok' }>,
): string {
  if (outcome.kind === 'authority_revoked') {
    return (
      `Cannot resume "${slug}": the access this run executes under is no longer held — ` +
      `${outcome.detail}. Ask a tenant admin to restore the principal's access to this space.`
    );
  }
  if (outcome.kind === 'authority_unavailable') {
    return (
      `Cannot resume "${slug}": this run carries an execution principal but its current access grant ` +
      `could not be established — ${outcome.detail}. This does not mean the access was withdrawn, ` +
      `only that it could not be read, so retry once the capability configuration resolves. ` +
      `Resuming meanwhile would dispatch its operation tasks on an unverified snapshot, since they ` +
      `never pass step gating.`
    );
  }
  const lines = outcome.ungrantedOperations.map(
    (op) => `  - ${op.operationId} — ${op.reason} (tasks: ${op.consumingTaskIds.join(', ')})`,
  );
  return (
    `Cannot resume "${slug}": its authority does not cover every operation the run would dispatch:\n` +
    `${lines.join('\n')}\n` +
    `Close the gap first — acknowledging this pause does not grant the operation, and operation ` +
    `tasks are dispatched without a second gate.`
  );
}
