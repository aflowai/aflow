import { describe, expect, it } from 'vitest';
import {
  enqueueWorkflowHarnessAdvance,
  parseWorkflowHarnessAdvanceFields,
  type WorkflowHarnessAdvanceMessage,
} from '../workflowHarnessAdvance.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const RUN = '11111111-2222-3333-4444-555555555555';
const SPACE = '22222222-3333-4444-5555-666666666666';

/** Minimal redis stub capturing the xadd field args as a {key:value} map. */
function fakeRedis() {
  const calls: Array<Record<string, string>> = [];
  return {
    calls,
    xadd: (_stream: string, _star: string, ...args: string[]): Promise<string> => {
      const fields: Record<string, string> = {};
      for (let i = 0; i < args.length; i += 2) {
        const k = args[i];
        const v = args[i + 1];
        if (k !== undefined && v !== undefined) fields[k] = v;
      }
      calls.push(fields);
      return Promise.resolve('1-0');
    },
  };
}

describe('workflow harness-advance — cancel action', () => {
  it('enqueues action+reason and round-trips through parse', async () => {
    const redis = fakeRedis();
    const msg: WorkflowHarnessAdvanceMessage = {
      tenantId: TENANT,
      workflowRunId: RUN,
      spaceId: SPACE,
      action: 'cancel',
      reason: 'operator abandoned the run',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake redis
    await enqueueWorkflowHarnessAdvance(redis as any, msg);

    expect(redis.calls).toHaveLength(1);
    const fields = redis.calls[0]!;
    expect(fields['action']).toBe('cancel');
    expect(fields['reason']).toBe('operator abandoned the run');

    const parsed = parseWorkflowHarnessAdvanceFields(fields);
    expect(parsed).toEqual(msg);
  });

  it('round-trips cancelledBy (operator-cancel legibility) and drops unknown actors', async () => {
    const redis = fakeRedis();
    const msg: WorkflowHarnessAdvanceMessage = {
      tenantId: TENANT,
      workflowRunId: RUN,
      spaceId: SPACE,
      action: 'cancel',
      cancelledBy: 'operator',
      reason: 'stop',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake redis
    await enqueueWorkflowHarnessAdvance(redis as any, msg);
    const fields = redis.calls[0]!;
    expect(fields['cancelledBy']).toBe('operator');
    expect(parseWorkflowHarnessAdvanceFields(fields)).toEqual(msg);

    // Unknown actor values are dropped at parse — the consumer falls back to
    // the WorkflowRunCancellationSchema default ('system').
    const parsed = parseWorkflowHarnessAdvanceFields({
      tenantId: TENANT,
      workflowRunId: RUN,
      spaceId: SPACE,
      action: 'cancel',
      cancelledBy: 'bogus',
    });
    expect(parsed?.cancelledBy).toBeUndefined();
  });

  it('a plain advance carries no action — parse leaves it undefined', () => {
    const parsed = parseWorkflowHarnessAdvanceFields({
      tenantId: TENANT,
      workflowRunId: RUN,
      spaceId: SPACE,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.action).toBeUndefined();
    expect(parsed?.reason).toBeUndefined();
    expect(parsed?.failedTaskId).toBeUndefined();
  });

  it('ignores an unknown action value (only "cancel"/"retry_dispatch" recognised)', () => {
    const parsed = parseWorkflowHarnessAdvanceFields({
      tenantId: TENANT,
      workflowRunId: RUN,
      spaceId: SPACE,
      action: 'bogus',
    });
    expect(parsed?.action).toBeUndefined();
  });

  it('round-trips a retry_dispatch action + taskId (interrupt-restart resume)', async () => {
    const redis = fakeRedis();
    const msg: WorkflowHarnessAdvanceMessage = {
      tenantId: TENANT,
      workflowRunId: RUN,
      spaceId: SPACE,
      action: 'retry_dispatch',
      taskId: 'execute',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake redis
    await enqueueWorkflowHarnessAdvance(redis as any, msg);
    const fields = redis.calls[0]!;
    expect(fields['action']).toBe('retry_dispatch');
    expect(fields['taskId']).toBe('execute');
    expect(parseWorkflowHarnessAdvanceFields(fields)).toEqual(msg);
  });
});
