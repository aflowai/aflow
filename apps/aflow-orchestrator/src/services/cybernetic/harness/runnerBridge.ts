/**
 * Runner session bridge — spawn + terminal intercept routing.
 */
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  appendSessionEvent,
  getSessionState,
  setSessionState,
  markSessionDirty,
  addControlMessage,
  type SessionEvent,
  type SessionHotState,
} from '@aflow/redis';
import { and, eq } from 'drizzle-orm';
import { createTenantContext, withTenantSchema, workflowRuns } from '@aflow/database';
import type {
  TenantId,
  TraceId,
  IdempotencyKey,
  ActorContext,
  SimulationRunInput,
  SystemRole,
  AgentId,
  SessionAgentTarget,
} from '@aflow/schemas';
import {
  ActorContextSchema,
  isCustomAgentRef,
  MAX_INLINE_PAYLOAD_BYTES,
  SimulationRunInputSchema,
} from '@aflow/schemas';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';

/** The one role a workflow task's `runner_*` configuration is addressed to. */
const CYBERNETIC_RUNNER_ROLE = 'cybernetic-runner';
import type {
  HarnessDeps,
  RunnerTerminalKind,
  RunnerTerminalPayloads,
  SpawnRunnerSessionArgs,
  WorkflowExecutionRef,
  WorkflowTaskOutcome,
} from './types.js';
import { resolveWorkflowTaskAuthority } from './taskAuthority.js';
import { onWorkflowTaskComplete } from './dispatch.js';
import { validateRunnerOutputContractAtHarness } from './validateRunnerOutputContract.js';

export type {
  RunnerTerminalKind,
  RunnerTerminalPayloads,
  SpawnRunnerSessionArgs,
} from './types.js';

export async function spawnRunnerSession(
  deps: HarnessDeps,
  args: SpawnRunnerSessionArgs,
): Promise<void> {
  const { tenantId, spaceId, workerSessionId, helmsmanSessionId, workflowExecution, inputRef } =
    args;
  const tenantIdStr = tenantId as string;
  const now = Date.now();

  const helmsmanState = await getSessionState(deps.redis, tenantIdStr, helmsmanSessionId);

  // These land as raw JSON strings on Redis hot state — there is no spill
  // path for them (unlike the input ref), so an oversized one is a payload
  // discipline breach worth surfacing.
  for (const [field, value] of [
    ['delegationContextJson', args.delegationContextJson],
    ['finalOutputSchemaOverrideJson', args.finalOutputSchemaOverrideJson],
  ] as const) {
    if (value === undefined) continue;
    const bytes = Buffer.byteLength(value, 'utf-8');
    if (bytes > MAX_INLINE_PAYLOAD_BYTES) {
      getOrchestratorLogger().warn(
        `[spawnRunnerSession] ${field} for run=${workflowExecution.runId} task=${workflowExecution.taskId} is ${String(bytes)} bytes (inline threshold ${String(MAX_INLINE_PAYLOAD_BYTES)}) — oversized string reaches Redis hot state`,
      );
    }
  }

  // A workflow task is executed either by the RUNNER — whose `runner_*`
  // configuration a task carries, and which no other platform role would
  // accept — or by an operator-authored agent named on `task.agent`, which
  // brings its own prompt and tools and is dispatched with none of that
  // configuration. Naming any OTHER platform role used to fail in the worst
  // available way: the ref was cast to a SystemRole, a session was created
  // against a role nobody registered, nothing resolved, no step ever ran, and
  // the task came back failed with no error code, no classification and no
  // summary. Unretryable, and unreadable.
  const custom = isCustomAgentRef(args.agentDefinitionRef);
  if (!custom && args.agentDefinitionRef !== CYBERNETIC_RUNNER_ROLE) {
    throw new Error(
      `Task agent "${args.agentDefinitionRef}" cannot run a workflow task. Tasks are executed by "${CYBERNETIC_RUNNER_ROLE}", which is who the runner_* configuration a task carries is addressed to, or by an operator-authored agent named by its id. Another platform role would reject that configuration as unknown.`,
    );
  }

  const runnerTarget: SessionAgentTarget = custom
    ? { kind: 'custom-agent', agentId: args.agentDefinitionRef as AgentId }
    : { kind: 'platform-role', systemRole: args.agentDefinitionRef as SystemRole };

  // Read before the state literal so the grant rides the write that creates
  // the hash it lives in (Plan 28 §P3).
  const authority = await resolveWorkflowTaskAuthority(
    deps.redis,
    deps.db,
    tenantIdStr,
    helmsmanSessionId,
    helmsmanState,
    workerSessionId,
  );

  // Build QUEUED Runner session hot state. Inherits createdBy +
  // actorContextJson from the Helmsman so RunAccessGrant compilation
  const queuedState: SessionHotState = {
    sessionId: workerSessionId,
    tenantId: tenantIdStr,
    target: runnerTarget,
    // `latest` unless the run pinned a version. A measured run has to face the
    // agent its manifest recorded, not whichever one is current when the task
    // happens to dispatch.
    agentVersion: args.agentVersion ?? 'latest',
    status: 'QUEUED',
    createdAt: now,
    startedAt: now,
    inputRef,
    traceId: args.traceId,
    idempotencyKey: `dispatch:${workflowExecution.runId}:${workflowExecution.taskId}:${String(workflowExecution.attempt)}`,
    lastUpdatedAt: now,
    spaceId,
    workflowExecution,
    // parentSessionId: intentionally undefined — Runner has no cascade
    // parent. Helmsman observes via workflow_run_waiters.
    agentRoleOverride: 'subagent',
    ...(authority.credentialOwnerId ? { createdBy: authority.credentialOwnerId } : {}),
    ...(authority.actorContextJson ? { actorContextJson: authority.actorContextJson } : {}),
    ...(authority.grantJson !== undefined ? { grantJson: authority.grantJson } : {}),
    ...(authority.rootTrigger !== undefined ? { rootTrigger: authority.rootTrigger } : {}),
    ...(helmsmanState?.spaceContextJson
      ? {
          spaceContextJson: helmsmanState.spaceContextJson,
          spaceContextBuiltAt: helmsmanState.spaceContextBuiltAt ?? now,
        }
      : {}),
    ...(args.delegationContextJson !== undefined
      ? { delegationContextJson: args.delegationContextJson }
      : {}),
    ...(args.finalOutputSchemaOverrideJson !== undefined
      ? { finalOutputSchemaOverrideJson: args.finalOutputSchemaOverrideJson }
      : {}),
    ...(args.finalOutputValidatorRefs !== undefined
      ? { finalOutputValidatorRefs: args.finalOutputValidatorRefs }
      : {}),
    ...(args.delegationDisplayWorkflowSlug !== undefined
      ? { delegationDisplayWorkflowSlug: args.delegationDisplayWorkflowSlug }
      : {}),
    ...(args.delegationDisplayTaskId !== undefined
      ? { delegationDisplayTaskId: args.delegationDisplayTaskId }
      : {}),
    ...(args.delegationDisplayTaskName !== undefined
      ? { delegationDisplayTaskName: args.delegationDisplayTaskName }
      : {}),
  };
  await setSessionState(deps.redis, queuedState);

  // Emit SessionQueued event for observability
  const queuedEvent: SessionEvent = {
    eventId: randomUUID(),
    eventType: 'SessionQueued',
    timestamp: now,
    sessionId: workerSessionId,
    metadata: {
      systemRole: args.agentDefinitionRef,
      workflowExecution,
    },
  };
  await appendSessionEvent(deps.redis, tenantIdStr, workerSessionId, queuedEvent);
  await markSessionDirty(deps.redis, tenantIdStr, workerSessionId);

  let actorContext: ActorContext | undefined;
  if (authority.actorContextJson) {
    try {
      actorContext = ActorContextSchema.parse(JSON.parse(authority.actorContextJson));
    } catch {
      // Best-effort — if parent has no valid actorContext, Runner runs without grant
    }
  }

  // Inherited from the workflow run, not resolved here. The pins are what make
  // a run measurable — which persona, which baseline, which model — and a task
  // session that resolved its own defaults would answer as a different caller
  // than the run was started as.
  let simulationRunInput: SimulationRunInput | undefined;
  let storedPins: unknown;
  try {
    const rows = await withTenantSchema(deps.db, createTenantContext(tenantId), async (tx) =>
      tx
        .select({ pins: workflowRuns.simulationRunInputJson })
        .from(workflowRuns)
        .where(
          and(eq(workflowRuns.spaceId, spaceId), eq(workflowRuns.runId, workflowExecution.runId)),
        )
        .limit(1),
    );
    storedPins = rows[0]?.pins;
  } catch (err) {
    // Only the READ is allowed to fail open: a transient database error would
    // otherwise break dispatch for every space, including the majority that pin
    // nothing. Logged rather than swallowed, because a run that quietly took
    // the defaults is indistinguishable afterwards from one that had none.
    getOrchestratorLogger().warn(
      `runnerBridge: could not read simulation pins for run ${workflowExecution.runId}, dispatching against simulation defaults: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (storedPins != null) {
    // Malformed pins are NOT allowed to fail open. The row says this run was
    // pinned; answering it as a different caller, against a different baseline,
    // produces a measurement that reads as valid and is not.
    const parsed = SimulationRunInputSchema.safeParse(storedPins);
    if (!parsed.success) {
      throw new Error(
        `runnerBridge: run ${workflowExecution.runId} carries unreadable simulation pins; refusing to dispatch a task against different pins than the run was started with: ${parsed.error.message}`,
      );
    }
    simulationRunInput = parsed.data;
  }

  await addControlMessage(deps.redis, {
    messageVersion: 1,
    type: 'start_run',
    tenantId,
    runId: workerSessionId,
    ...(simulationRunInput ? { simulationRunInput } : {}),
    target: runnerTarget,
    // The same version the queued state carries. These disagreeing is how a
    // run reads as pinned in hot state while executing whatever is current:
    // the control message is what the consumer resolves the definition from.
    agentVersion: args.agentVersion ?? 'latest',
    inputRef,
    traceId: args.traceId,
    idempotencyKey: queuedState.idempotencyKey as IdempotencyKey,
    requestedAtMs: now,
    spaceId,
    ...(authority.credentialOwnerId ? { createdBy: authority.credentialOwnerId } : {}),
    ...(actorContext ? { actorContext } : {}),
  });
}

export async function routeRunnerTerminalToHarness(
  deps: HarnessDeps,
  runState: { workflowExecution?: WorkflowExecutionRef; tenantId: string; traceId?: string },
  kind: RunnerTerminalKind,
  payloads: RunnerTerminalPayloads,
): Promise<void> {
  if (!runState.workflowExecution) {
    throw new Error(
      'routeRunnerTerminalToHarness called without workflowExecution — caller should guard',
    );
  }

  let outcome: WorkflowTaskOutcome;
  if (kind === 'SUCCEEDED') {
    if (!payloads.outputRef) {
      throw new Error(
        `Runner-terminal SUCCEEDED missing outputRef ` +
          `(runId=${runState.workflowExecution.runId} taskId=${runState.workflowExecution.taskId})`,
      );
    }
    outcome = await validateRunnerOutputContractAtHarness({
      deps,
      tenantId: runState.tenantId,
      workflowExecution: runState.workflowExecution,
      outputRef: payloads.outputRef,
    });
  } else if (kind === 'FAILED') {
    outcome = {
      kind: 'failed',
      ...(payloads.errorRef ? { errorRef: payloads.errorRef } : {}),
      ...(payloads.failureReason ? { failureReason: payloads.failureReason } : {}),
    };
  } else {
    outcome = {
      kind: 'paused',
      ...(payloads.contractRef ? { contractRef: payloads.contractRef } : {}),
    };
  }

  await onWorkflowTaskComplete(deps, {
    tenantId: runState.tenantId as TenantId,
    workflowExecution: runState.workflowExecution,
    outcome,
    ...(runState.traceId ? { traceId: runState.traceId as TraceId } : {}),
  });
}
