/**
 * `model.runtime.*` — Helmsman reads the model runtime on this computer and
 * asks before changing it (Plan 323 D10). The change parks on the
 * write-approval pause, as a browser action does; once the operator approves,
 * the step comes back here with its input, rebuilds the request from a fresh
 * diagnosis, and runs only when the approval it finds is for that same request
 * — a change whose impact moved since asks again with the new one.
 */
import { getDatabase } from '@aflow/database';
import {
  applyLocalModelAction,
  diagnoseSpaceLocalRuntime,
  localRoleModels,
  localRuntimeChangeRequest,
  readSpaceModelDefaults,
  resolveSpaceLocalRuntime,
  type SpaceLocalRuntime,
} from '@aflow/cybernetic-runtime';
import { countRuntimeRequests, getWriteApprovalGrant, spendWriteApprovalGrant } from '@aflow/redis';
import {
  MODEL_RUNTIME_CHANGE_OPERATION_ID,
  MODEL_RUNTIME_STATUS_OPERATION_ID,
  ModelRuntimeChangeInputSchema,
  type LocalModelWriteApprovalRequestPayload,
} from '@aflow/schemas';
import { getOrchestratorLogger } from '../../../../../lib/orchestratorLogger.js';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepError, emitStepPaused, emitStepSuccess, readInlineOpInput } from '../helpers.js';
import { requireSpaceId } from '../spaceScope.js';
import { sessionUser } from '../sessionUser.js';

interface Scope {
  runtime: SpaceLocalRuntime | null;
  roles: ReturnType<typeof localRoleModels>;
}

async function resolveScope(args: InlineHandlerArgs): Promise<Scope> {
  const db = getDatabase();
  const tenantId = args.context.tenantId as string;
  const spaceId = requireSpaceId(args.context);
  const userId = await sessionUser(args);
  const runtime = userId
    ? await resolveSpaceLocalRuntime({ db, redis: args.redis, tenantId, userId, spaceId })
    : null;
  const roles = localRoleModels(await readSpaceModelDefaults(db, tenantId, spaceId));
  return { runtime, roles };
}

const NO_CONNECTION =
  'This space has no Ollama connection. The operator adds one under Settings → Credentials.';

async function handleStatus(args: InlineHandlerArgs, startTime: number): Promise<void> {
  const { runtime, roles } = await resolveScope(args);
  if (!runtime) {
    await emitStepSuccess(args, { diagnostics: null, note: NO_CONNECTION }, startTime);
    return;
  }
  const diagnostics = await diagnoseSpaceLocalRuntime({ runtime, redis: args.redis, roles });
  await emitStepSuccess(args, { diagnostics }, startTime);
}

async function handleChange(args: InlineHandlerArgs, startTime: number): Promise<void> {
  const parsed = ModelRuntimeChangeInputSchema.safeParse((await readInlineOpInput(args)) ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    await emitStepError(
      args,
      'MODEL_RUNTIME_INVALID_INPUT',
      `Invalid input for ${MODEL_RUNTIME_CHANGE_OPERATION_ID}: ${issues}. Pass an issue's remedy action as \`change\`; a remedy that assigns a role's model is the operator's, under Settings → Agents.`,
      startTime,
      'validation',
    );
    return;
  }
  const { change } = parsed.data;
  const { runtime, roles } = await resolveScope(args);
  if (!runtime) {
    await emitStepError(
      args,
      'MODEL_RUNTIME_NO_CONNECTION',
      NO_CONNECTION,
      startTime,
      'validation',
    );
    return;
  }
  const diagnostics = await diagnoseSpaceLocalRuntime({ runtime, redis: args.redis, roles });
  const request = localRuntimeChangeRequest({
    operationId: MODEL_RUNTIME_CHANGE_OPERATION_ID,
    change,
    diagnostics,
    inFlightRequests: await countRuntimeRequests(args.redis, runtime.runtimeId),
    askingModel: roles.helmsman,
  });

  const { tenantId, runId } = args.context;
  const grant = await getWriteApprovalGrant(args.redis, tenantId, runId, request.requestHash);
  if (grant?.decision === 'denied') {
    await emitStepError(
      args,
      'MODEL_RUNTIME_CHANGE_DENIED',
      `The operator declined this change${grant.reason ? `: ${grant.reason}` : '.'} Do not ask for it again unless they do.`,
      startTime,
      'permission',
    );
    return;
  }
  const spent =
    grant?.decision === 'approved' &&
    (await spendWriteApprovalGrant(args.redis, tenantId, runId, grant));
  if (!spent) {
    const ask: LocalModelWriteApprovalRequestPayload = {
      ...request,
      // An approval already used for this exact request is not one for asking again.
      ...(grant?.decidedAt ? { decidedBefore: grant.decidedAt } : {}),
    };
    await emitStepPaused(args, ask, startTime);
    return;
  }

  const outcome = await applyLocalModelAction(
    { db: getDatabase(), redis: args.redis, tenantId: tenantId as string, runtime },
    change,
  );
  if (outcome.ok) {
    await emitStepSuccess(args, { message: outcome.message }, startTime);
    return;
  }
  await emitStepError(
    args,
    `MODEL_RUNTIME_${outcome.reason.toUpperCase()}`,
    outcome.message,
    startTime,
    outcome.reason === 'runtime' ? 'provider' : 'validation',
  );
}

export async function handleModelRuntimeInline(args: InlineHandlerArgs): Promise<void> {
  const operationId = args.stepDef.operation;
  const startTime = Date.now();
  try {
    switch (operationId) {
      case MODEL_RUNTIME_STATUS_OPERATION_ID:
        await handleStatus(args, startTime);
        break;
      case MODEL_RUNTIME_CHANGE_OPERATION_ID:
        await handleChange(args, startTime);
        break;
      default:
        await emitStepError(
          args,
          'UNKNOWN_OPERATION',
          `Unknown model operation: ${operationId}`,
          startTime,
          'validation',
        );
    }
  } catch (err) {
    getOrchestratorLogger().error(
      `model: ${operationId} failed: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined,
      { tenantId: args.context.tenantId, sessionId: args.context.runId },
    );
    await emitStepError(
      args,
      'MODEL_RUNTIME_OPERATION_FAILED',
      `System error: ${operationId} could not be completed due to an internal failure. Do not retry — report this to the operator.`,
      startTime,
      'internal',
    );
  }
}
