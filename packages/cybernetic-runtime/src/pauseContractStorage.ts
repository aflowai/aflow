import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  WorkflowResumeContractSchema,
  OAuthConsentRequestPayloadSchema,
  isSubagentHandoffPayload,
  type TenantId,
  type SessionId,
  type StepExecutionId,
  type WorkflowResumeContract,
  type WorkflowRunPauseReason,
  type WorkflowTask,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import { pauseRun, repausePausedRunAtVersion } from './ledger/runs.js';
import { getCyberneticLogger } from './logger.js';
import { buildResumeContract } from './workflowResume.js';

export interface StoreWorkflowResumeContractArgs {
  payloadStore: PayloadStore;
  tenantId: string;
  runId: string;
  taskId: string;
  attempt: number;
  contract: WorkflowResumeContract;
}

/** Persist a `WorkflowResumeContract` and return its PayloadStore ref. */
export async function storeWorkflowResumeContract(
  args: StoreWorkflowResumeContractArgs,
): Promise<string> {
  return args.payloadStore.store({
    tenantId: args.tenantId as TenantId,
    runId: args.runId as SessionId,
    stepExecutionId: args.taskId as StepExecutionId,
    attempt: args.attempt,
    kind: 'output',
    data: args.contract,
  });
}

export interface ResolvedPausedContract {
  contractRef: string;
  /** Typed pause cause for `workflow_runs.paused_reason`. */
  pauseReason: WorkflowRunPauseReason;
}

export interface ResolvePausedContractRefArgs {
  payloadStore: PayloadStore;
  tenantId: string;
  runId: string;
  taskId: string;
  pausedTaskAttempt: number;
  contractRef: string;
  taskDef: WorkflowTask | null;
}

/**
 * Normalize a paused-task `contractRef` into a stored `WorkflowResumeContract`
 * plus the matching `paused_reason`. Subagent handoff payloads are wrapped via
 * `buildResumeContract`; already-shaped contracts pass through unchanged.
 */
export async function resolvePausedContractRef(
  args: ResolvePausedContractRefArgs,
): Promise<ResolvedPausedContract | null> {
  let payload: unknown;
  try {
    payload = await args.payloadStore.retrieve(args.contractRef as never);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const existing = WorkflowResumeContractSchema.safeParse(payload);
  if (existing.success) {
    return { contractRef: args.contractRef, pauseReason: existing.data.pauseCause };
  }

  // OAuth consent pause (Plan 185 §9.3, Plane B): a Runner's tool/API call that
  // could not resolve a pinned OAuth owner/token parks the task with an
  // `oauth_consent` request payload (the same payload the step plane reads).
  // Build the run-plane `needs_oauth_consent` contract so the run pause carries
  // the typed cause into `paused_reason` + the `workflow_run_paused` attention.
  const consent = OAuthConsentRequestPayloadSchema.safeParse(payload);
  if (consent.success) {
    const contract = buildResumeContract({
      pauseCause: 'needs_oauth_consent',
      runId: args.runId,
      taskId: args.taskId,
      oauthConsent: {
        integrationKind: consent.data.integrationKind,
        resourceKey: consent.data.resourceKey,
        bindingId: consent.data.bindingId,
        ownerScope: consent.data.ownerScope,
        ...(consent.data.consentUrlHint ? { consentUrlHint: consent.data.consentUrlHint } : {}),
        reason: consent.data.reason,
      },
    });
    try {
      const contractRef = await storeWorkflowResumeContract({
        payloadStore: args.payloadStore,
        tenantId: args.tenantId,
        runId: args.runId,
        taskId: args.taskId,
        attempt: args.pausedTaskAttempt,
        contract,
      });
      return { contractRef, pauseReason: 'needs_oauth_consent' };
    } catch {
      return null;
    }
  }

  if (!isSubagentHandoffPayload(payload)) {
    return null;
  }

  const credentialBlock = payload.credentialBlock;
  const contract = credentialBlock
    ? buildResumeContract({
        pauseCause: 'needs_credentials',
        runId: args.runId,
        taskId: args.taskId,
        blockedBindings: [
          {
            bindingId: credentialBlock.bindingId ?? '(unknown)',
            bindingName: credentialBlock.bindingName ?? credentialBlock.serverId ?? '(unknown)',
            missingFields: credentialBlock.missingFields ?? [],
          },
        ],
      })
    : buildResumeContract({
        pauseCause: 'subagent_handoff',
        runId: args.runId,
        taskId: args.taskId,
        taskDef: args.taskDef,
        handoff: payload,
        pausedTaskAttempt: args.pausedTaskAttempt,
      });
  const pauseReason: WorkflowRunPauseReason = credentialBlock
    ? 'needs_credentials'
    : 'subagent_handoff';

  try {
    const contractRef = await storeWorkflowResumeContract({
      payloadStore: args.payloadStore,
      tenantId: args.tenantId,
      runId: args.runId,
      taskId: args.taskId,
      attempt: args.pausedTaskAttempt,
      contract,
    });
    return { contractRef, pauseReason };
  } catch {
    return null;
  }
}

export interface RewritePausedRunContractArgs {
  db: PostgresJsDatabase;
  payloadStore: PayloadStore;
  tenantId: string;
  runId: string;
  taskId: string;
  attempt: number;
  contract: WorkflowResumeContract;
  expectedPauseVersion?: number;
  resumeClaimToken?: string;
}

/**
 * Replace the paused run's stored contract (bumps `pause_version`). Used when a
 * pause cycle promotes to `retry_budget_exceeded`. Prefer passing
 * `expectedPauseVersion` + `resumeClaimToken` from the resume lease holder.
 */
export async function rewritePausedRunContract(
  args: RewritePausedRunContractArgs,
): Promise<string | null> {
  try {
    const contractRef = await storeWorkflowResumeContract({
      payloadStore: args.payloadStore,
      tenantId: args.tenantId,
      runId: args.runId,
      taskId: args.taskId,
      attempt: args.attempt,
      contract: args.contract,
    });
    if (args.expectedPauseVersion !== undefined) {
      const repaused = await repausePausedRunAtVersion(args.db, args.tenantId, args.runId, {
        reason: args.contract.pauseCause,
        payloadRef: contractRef,
        expectedPauseVersion: args.expectedPauseVersion,
        ...(args.resumeClaimToken !== undefined ? { resumeClaimToken: args.resumeClaimToken } : {}),
      });
      if (!repaused) {
        return null;
      }
    } else {
      await pauseRun(args.db, args.tenantId, args.runId, {
        reason: args.contract.pauseCause,
        payloadRef: contractRef,
      });
    }
    return contractRef;
  } catch (err) {
    getCyberneticLogger().warn(
      `[rewritePausedRunContract] failed for run=${args.runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
