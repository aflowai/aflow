import { describe, expect, it, vi } from 'vitest';
import type { TenantId, WorkflowTask, Workflow } from '@aflow/schemas';
import type { WorkflowTaskRow } from '@aflow/cybernetic-runtime';
import { applyOpTaskOutputContract } from '../opTaskOutputContract.js';
import type { HarnessDeps } from '../types.js';

const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;
const RUN_ID = 'run-1';
const TASK_ID = 'poll-lb';
const ATTEMPT = 1;
const RAW_REF = 'ref:raw-output';
const INPUT_REF = 'ref:resolved-input';

const workflowExecution = { runId: RUN_ID, taskId: TASK_ID, attempt: ATTEMPT };

function opTaskDef(over?: Partial<WorkflowTask>): WorkflowTask {
  return {
    taskId: TASK_ID,
    name: 'Poll LB',
    goal: 'poll',
    type: 'operation',
    operation: 'mcp.tool.call',
    ...over,
  } as WorkflowTask;
}

function taskRow(over?: Partial<WorkflowTaskRow>): WorkflowTaskRow {
  return {
    id: 'row-1',
    runId: RUN_ID,
    taskId: TASK_ID,
    status: 'running',
    attempt: ATTEMPT,
    sessionId: null,
    workerSessionId: 'worker-1',
    startedAt: new Date(),
    completedAt: null,
    durationMs: null,
    costCents: null,
    metricsJson: null,
    summary: null,
    failureReason: null,
    outputRef: null,
    inputRef: INPUT_REF,
    reflectionJson: null,
    operationId: 'mcp.tool.call',
    errorCode: null,
    errorClassification: null,
    errorRetryable: null,
    failedAt: null,
    priorFailures: null,
    pollCycle: 1,
    ...over,
  } as WorkflowTaskRow;
}

function makeDeps(payloadsByRef: Record<string, unknown>) {
  const stored: Array<{ stepExecutionId: string; kind: string; data: unknown; attempt: number }> =
    [];
  let storeSeq = 0;
  const payloadStore = {
    retrieve: vi.fn((ref: string) => {
      if (ref in payloadsByRef) return Promise.resolve(payloadsByRef[ref]);
      return Promise.reject(new Error(`no payload for ${ref}`));
    }),
    store: vi.fn(
      (params: { stepExecutionId: string; kind: string; data: unknown; attempt: number }) => {
        stored.push(params);
        storeSeq += 1;
        return Promise.resolve(`ref:stored-${String(storeSeq)}`);
      },
    ),
  };
  const deps = { db: {}, redis: {}, payloadStore } as unknown as HarnessDeps;
  return { deps, stored, payloadStore };
}

const SUCCEEDED = { kind: 'succeeded' as const, outputRef: RAW_REF };

async function run(
  deps: HarnessDeps,
  taskDef: WorkflowTask | null,
  over?: { workflow?: Workflow | null; row?: Partial<WorkflowTaskRow> },
) {
  return applyOpTaskOutputContract(deps, {
    tenantId: TENANT,
    taskRow: taskRow(over?.row),
    workflow: over?.workflow ?? null,
    taskDef,
    workflowExecution,
    outcome: SUCCEEDED,
  });
}

describe('applyOpTaskOutputContract — pass-through lanes', () => {
  it('passes through non-operation tasks (Runner terminals validate elsewhere)', async () => {
    const { deps, payloadStore } = makeDeps({});
    const agentDef = { ...opTaskDef(), type: 'agent', operation: undefined } as WorkflowTask;
    const result = await run(deps, agentDef);
    expect(result).toEqual(SUCCEEDED);
    expect(payloadStore.retrieve).not.toHaveBeenCalled();
  });

  it('passes through when neither projection nor outputContract.schema exists', async () => {
    const { deps, payloadStore } = makeDeps({});
    const result = await run(deps, opTaskDef());
    expect(result).toEqual(SUCCEEDED);
    expect(payloadStore.retrieve).not.toHaveBeenCalled();
  });

  it('passes through on a payload retrieve failure for a VALIDATION-ONLY task (infra noise is not a violation)', async () => {
    const { deps } = makeDeps({}); // RAW_REF not present → retrieve rejects
    const result = await run(
      deps,
      opTaskDef({
        outputContract: { schema: { type: 'object', required: ['x'] } },
      }),
    );
    expect(result).toEqual(SUCCEEDED);
  });

  it('passes through when the task definition is unresolvable', async () => {
    const { deps } = makeDeps({});
    const result = await run(deps, null);
    expect(result).toEqual(SUCCEEDED);
  });
});

describe('applyOpTaskOutputContract — output validation invariant (raw)', () => {
  const SCHEMA = {
    type: 'object',
    properties: { status: { type: 'string' } },
    required: ['status'],
  };

  it('passes a conforming raw output through with the ORIGINAL ref (no new payload)', async () => {
    const { deps, stored } = makeDeps({ [RAW_REF]: { status: 'COMPLETE' } });
    const result = await run(deps, opTaskDef({ outputContract: { schema: SCHEMA } }));
    expect(result).toEqual(SUCCEEDED);
    expect(stored).toHaveLength(0);
  });

  it('pauses (task_contract_violation) on a raw output violating the schema', async () => {
    const { deps, stored } = makeDeps({ [RAW_REF]: { wrong: true } });
    const result = await run(deps, opTaskDef({ outputContract: { schema: SCHEMA } }));
    expect(result.kind).toBe('paused');
    if (result.kind !== 'paused') return;
    expect(result.taskOutputRef).toBe(RAW_REF);
    // Two persisted payloads: the structured error (kind 'error') and the
    const errorPayload = stored.find((s) => s.kind === 'error')!.data as { code: string };
    expect(errorPayload.code).toBe('OUTPUT_CONTRACT_VIOLATION');
    const contract = stored.find((s) => s.kind === 'output')!.data as {
      pauseCause: string;
      resumePrompt: string;
    };
    expect(contract.pauseCause).toBe('task_contract_violation');
    expect(contract.resumePrompt).toContain('status');
  });

  it('excludes the reserved _poll stamp from raw validation (strict schemas still pass)', async () => {
    const { deps } = makeDeps({
      [RAW_REF]: { status: 'PENDING', _poll: { cycles: 5, exhausted: true, conditionMet: false } },
    });
    const result = await run(
      deps,
      opTaskDef({ outputContract: { schema: { ...SCHEMA, additionalProperties: false } } }),
    );
    expect(result).toEqual(SUCCEEDED);
  });

  it('fails closed (OUTPUT_SCHEMA_INVALID) when the schema cannot compile', async () => {
    const { deps } = makeDeps({ [RAW_REF]: { status: 'COMPLETE' } });
    const result = await run(
      deps,
      opTaskDef({
        outputContract: { schema: { type: 'object', required: 'not-an-array' as never } },
      }),
    );
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.errorCode).toBe('OUTPUT_SCHEMA_INVALID');
    expect(result.errorRetryable).toBe(false);
  });
});

describe('applyOpTaskOutputContract — projection', () => {
  const KAGGLE_RAW = {
    status: 'COMPLETE',
    content: [{ type: 'text', text: '{"publicScore":"0.124"}' }],
  };
  const PROJECTION = {
    status: { path: 'status', onMissing: 'error' as const },
    lbValue: {
      path: 'content[0].text',
      parse: ['json' as const, 'number' as const],
      select: 'publicScore',
      onMissing: 'null' as const,
    },
  };
  const SCHEMA = {
    type: 'object',
    properties: { status: { type: 'string' }, lbValue: { type: ['number', 'null'] } },
    required: ['status', 'lbValue'],
    additionalProperties: false,
  };

  it('writes the projected object as a NEW payload and repoints the outcome', async () => {
    const { deps, stored } = makeDeps({ [RAW_REF]: KAGGLE_RAW });
    const result = await run(
      deps,
      opTaskDef({ outputProjection: PROJECTION, outputContract: { schema: SCHEMA } }),
    );
    expect(result.kind).toBe('succeeded');
    if (result.kind !== 'succeeded') return;
    expect(result.outputRef).not.toBe(RAW_REF);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.stepExecutionId).toBe(`${TASK_ID}:projected`);
    expect(stored[0]!.kind).toBe('output');
    expect(stored[0]!.data).toEqual({ status: 'COMPLETE', lbValue: 0.124 });
  });

  it('projects without a schema (projection alone is allowed)', async () => {
    const { deps, stored } = makeDeps({ [RAW_REF]: KAGGLE_RAW });
    const result = await run(deps, opTaskDef({ outputProjection: PROJECTION }));
    expect(result.kind).toBe('succeeded');
    expect(stored[0]!.data).toEqual({ status: 'COMPLETE', lbValue: 0.124 });
  });

  it("onMissing: 'null' lands null for a legitimately-absent terminal value", async () => {
    const { deps, stored } = makeDeps({
      [RAW_REF]: { status: 'ERROR', content: [{ type: 'text', text: '{"status":"ERROR"}' }] },
    });
    const result = await run(
      deps,
      opTaskDef({ outputProjection: PROJECTION, outputContract: { schema: SCHEMA } }),
    );
    expect(result.kind).toBe('succeeded');
    expect(stored[0]!.data).toEqual({ status: 'ERROR', lbValue: null });
  });

  it('carries the _poll stamp onto the projected object but validates without it', async () => {
    const stamp = { cycles: 3, exhausted: false, conditionMet: true };
    const { deps, stored } = makeDeps({ [RAW_REF]: { ...KAGGLE_RAW, _poll: stamp } });
    const result = await run(
      deps,
      opTaskDef({ outputProjection: PROJECTION, outputContract: { schema: SCHEMA } }),
    );
    // additionalProperties: false + _poll present — validation must still pass.
    expect(result.kind).toBe('succeeded');
    expect(stored[0]!.data).toEqual({ status: 'COMPLETE', lbValue: 0.124, _poll: stamp });
  });

  it('echoes fromInput fields from the resolved op input (task row inputRef)', async () => {
    const { deps, stored } = makeDeps({
      [RAW_REF]: KAGGLE_RAW,
      [INPUT_REF]: { submissionId: 'sub-42', competitionName: 'titanic' },
    });
    const result = await run(
      deps,
      opTaskDef({
        inputBindings: { submissionId: { kind: 'run_input', path: 'submissionId' } },
        outputProjection: {
          status: { path: 'status', onMissing: 'error' as const },
          submissionId: { fromInput: 'submissionId' },
        },
      }),
    );
    expect(result.kind).toBe('succeeded');
    expect(stored[0]!.data).toEqual({ status: 'COMPLETE', submissionId: 'sub-42' });
  });

  it('PROJECTION_FAILED with no resolution FAILS rather than pausing', async () => {
    const { deps, stored } = makeDeps({
      [RAW_REF]: { content: [{ type: 'text', text: '{}' }] }, // no status field
    });
    // Default fixture: no outputContract.schema (so no replaceOutputSchema) and
    // retryability 'unknown' (so re_execute is not advertisable) — a pause here
    // would have offered nothing but `fail`.
    const result = await run(deps, opTaskDef({ outputProjection: PROJECTION }));
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.errorCode).toBe('PROJECTION_FAILED');
    expect(result.errorRetryable).toBe(false);
    expect(result.failureReason).toContain('status');
    // No resume contract is written — there is nothing to resume.
    expect(stored.find((s) => s.kind === 'output')).toBeUndefined();
    const errorPayload = stored.find((s) => s.kind === 'error')!.data as {
      code: string;
      retryable: boolean;
      failures: Array<{ field: string; source: string }>;
    };
    expect(errorPayload.code).toBe('PROJECTION_FAILED');
    // The payload the agent reads must not contradict the row the run surface
    // reads — a retryable error here would invite retrying an unsafe op.
    expect(errorPayload.retryable).toBe(false);
    expect(errorPayload.failures[0]!.field).toBe('status');
    expect(errorPayload.failures[0]!.source).toBe('status');
  });

  it("PROJECTION_FAILED pauses when re_execute is a real resolution (retryability: 'safe')", async () => {
    const { deps, stored } = makeDeps({
      [RAW_REF]: { content: [{ type: 'text', text: '{}' }] },
    });
    const result = await run(
      deps,
      opTaskDef({ outputProjection: PROJECTION, retryability: 'safe' }),
    );
    expect(result.kind).toBe('paused');
    if (result.kind !== 'paused') return;
    expect(result.taskOutputRef).toBe(RAW_REF);
    const contract = stored.find((s) => s.kind === 'output')!.data as {
      pauseCause: string;
      resumePrompt: string;
    };
    expect(contract.pauseCause).toBe('task_contract_violation');
    expect(contract.resumePrompt).toContain('status');
    // A pause that can be resolved keeps the error payload retryable.
    const errorPayload = stored.find((s) => s.kind === 'error')!.data as { retryable: boolean };
    expect(errorPayload.retryable).toBe(true);
  });

  it("leads a projection failure with the op's own HTTP failure", async () => {
    const raw = {
      statusCode: 403,
      data: { code: 403, message: 'You must accept the rules for this competition' },
    };
    // Unresolvable shape → the peer's refusal leads the failure reason.
    const bare = makeDeps({ [RAW_REF]: raw });
    const failed = await run(bare.deps, opTaskDef({ outputProjection: PROJECTION }));
    expect(failed.kind).toBe('failed');
    if (failed.kind !== 'failed') return;
    expect(failed.failureReason).toContain('HTTP 403');
    expect(failed.failureReason).toContain('You must accept the rules for this competition');
    // The projection detail still follows — the refusal leads, it does not
    // replace what could not resolve.
    expect(failed.failureReason).toContain('status');

    // Resolvable shape → the same reading leads the resume prompt.
    const safe = makeDeps({ [RAW_REF]: raw });
    const paused = await run(
      safe.deps,
      opTaskDef({ outputProjection: PROJECTION, retryability: 'safe' }),
    );
    expect(paused.kind).toBe('paused');
    const contract = safe.stored.find((s) => s.kind === 'output')!.data as { resumePrompt: string };
    expect(contract.resumePrompt).toContain('HTTP 403');
    expect(contract.resumePrompt).toContain('You must accept the rules for this competition');
  });

  it('pauses (task_contract_violation) when the PROJECTED output violates the schema', async () => {
    const { deps, stored } = makeDeps({
      // status projects to a number → violates { status: string }.
      [RAW_REF]: { status: 42, content: [{ type: 'text', text: '{"publicScore":"0.1"}' }] },
    });
    const result = await run(
      deps,
      opTaskDef({ outputProjection: PROJECTION, outputContract: { schema: SCHEMA } }),
    );
    expect(result.kind).toBe('paused');
    if (result.kind !== 'paused') return;
    // The attempted task output is the PROJECTED payload (replace_output base).
    const projectedStore = stored.find((s) => s.stepExecutionId === `${TASK_ID}:projected`);
    expect(projectedStore).toBeDefined();
    expect(result.taskOutputRef).not.toBe(RAW_REF);
    const contract = stored.find((s) => s.stepExecutionId === TASK_ID && s.kind === 'output')!
      .data as { pauseCause: string };
    expect(contract.pauseCause).toBe('task_contract_violation');
  });

  it('fails loud (PROJECTION_PERSIST_FAILED) when the projected payload cannot be stored', async () => {
    const { deps, payloadStore } = makeDeps({ [RAW_REF]: KAGGLE_RAW });
    payloadStore.store.mockRejectedValueOnce(new Error('gcs down'));
    const result = await run(deps, opTaskDef({ outputProjection: PROJECTION }));
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.errorCode).toBe('PROJECTION_PERSIST_FAILED');
    expect(result.errorRetryable).toBe(true);
  });

  it('fails transient (PROJECTION_SOURCE_UNAVAILABLE) when the raw output cannot be retrieved and a projection is declared', async () => {
    // RAW_REF absent → retrieve rejects. With a declared projection this must
    // NOT pass through succeeded on the raw ref (that would silently skip
    // projection AND validation) — same posture as PROJECTION_PERSIST_FAILED.
    const { deps, stored } = makeDeps({});
    const result = await run(
      deps,
      opTaskDef({ outputProjection: PROJECTION, outputContract: { schema: SCHEMA } }),
    );
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.errorCode).toBe('PROJECTION_SOURCE_UNAVAILABLE');
    expect(result.errorClassification).toBe('transient');
    expect(result.errorRetryable).toBe(true);
    expect(stored).toHaveLength(0);
  });

  it('fails transient (PROJECTION_SOURCE_UNAVAILABLE) when the fromInput echo input cannot be retrieved', async () => {
    // INPUT_REF absent → echo-input retrieve rejects. An infra flake must not
    // masquerade as a validation failure (PROJECTION_FAILED).
    const { deps } = makeDeps({ [RAW_REF]: KAGGLE_RAW });
    const result = await run(
      deps,
      opTaskDef({
        outputProjection: {
          status: { path: 'status', onMissing: 'error' as const },
          submissionId: { fromInput: 'submissionId' },
        },
      }),
    );
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.errorCode).toBe('PROJECTION_SOURCE_UNAVAILABLE');
    expect(result.errorClassification).toBe('transient');
    expect(result.errorRetryable).toBe(true);
  });
});
