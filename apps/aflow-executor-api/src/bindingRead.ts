import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from '@aflow/redis';
import {
  StepJobMessageSchema,
  type TenantId,
  type SessionId,
  type PayloadRef,
} from '@aflow/schemas';
import { ApiCallHandler } from './handlers/api/ApiCallHandler.js';

export async function readBindingEndpoint(
  deps: {
    db: PostgresJsDatabase;
    redis: Redis;
    payloadStore: PayloadStore;
    tenantId: string;
    spaceId: string;
    runId: string;
    credentialOwnerId?: string;
  },
  bindingId: string,
  endpointId: string,
  params: Record<string, string>,
): Promise<unknown> {
  const tenantId = deps.tenantId as TenantId;
  const runId = deps.runId as SessionId;
  const job = StepJobMessageSchema.parse({
    tenantId,
    sessionId: runId,
    spaceId: deps.spaceId,
    ...(deps.credentialOwnerId ? { credentialOwnerId: deps.credentialOwnerId } : {}),
    stepExecutionId: randomUUID(),
    stepId: 'plan-merge-read',
    stepType: 'api',
    operationId: 'api.http.call',
    idempotencyKey: randomUUID(),
    inputRef: 'inline:e30=',
    traceId: randomUUID(),
    scheduledAtMs: Date.now(),
  });
  const input = { apiId: 'github', bindingId, endpointId, params, response: { parseAs: 'json' } };
  const noop = () => undefined;
  const ctx: ExecutorContext = {
    job,
    tenantId,
    runId,
    spaceId: deps.spaceId,
    stepExecutionId: job.stepExecutionId,
    logicalExecutionId: job.stepExecutionId,
    attempt: 1,
    idempotencyKey: job.idempotencyKey,
    traceId: job.traceId,
    operationId: job.operationId,
    readPayload: <T>() => Promise.resolve(input as T),
    writePayload: (kind, data) =>
      deps.payloadStore.store({
        tenantId,
        runId,
        stepExecutionId: job.stepExecutionId,
        attempt: 1,
        kind: kind === 'input_request' ? 'requested_input' : kind,
        data,
      }),
    outputExists: () => Promise.resolve(null),
    resolveAndValidateInput: () => Promise.reject(new Error('Unexpected input resolution')),
    emitRunEvent: () => Promise.resolve(),
    emitLiveDelta: () => Promise.resolve(),
    emitWorkflowProgress: () => Promise.resolve(),
    signal: AbortSignal.timeout(15_000),
    log: { debug: noop, info: noop, warn: noop, error: noop },
  };
  const result = await new ApiCallHandler(deps).execute(ctx);
  if (result.status !== 'SUCCEEDED') throw new Error('The binding could not attest this merge');
  const value = await deps.payloadStore.retrieve(result.outputRef);
  if (typeof value !== 'object' || value === null) throw new Error('Invalid GitHub response');
  const output = value as Record<string, unknown>;
  if (
    typeof output['statusCode'] !== 'number' ||
    output['statusCode'] < 200 ||
    output['statusCode'] >= 300
  )
    throw new Error('GitHub attestation request failed');
  return output['dataRef']
    ? deps.payloadStore.retrieve(output['dataRef'] as PayloadRef)
    : output['data'];
}
