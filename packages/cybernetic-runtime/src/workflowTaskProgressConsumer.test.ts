import { describe, it, expect } from 'vitest';
import { decodeLiveDeltaWake, decodeProgressEvent } from './workflowTaskProgressConsumer.js';

const RUN_ID = '00000000-0000-4000-8000-000000000001';

/** Flat XADD fields as the executor's `emitWorkflowProgress` writes them. */
function activityFields(over: Record<string, string> = {}): Record<string, string> {
  return {
    eventType: 'WorkflowTaskActivity',
    tenantId: 'tenant-1',
    runId: RUN_ID,
    taskId: 'implement',
    stepExecutionId: 'step-1',
    sequence: '2',
    metadata: JSON.stringify({
      operationId: 'code.agent.run',
      stepName: 'Coding agent working',
      stepDetail: 'The claude agent is editing files on agent/add-readme.',
    }),
    ...over,
  };
}

describe('decodeProgressEvent — WorkflowTaskActivity branch', () => {
  it('decodes an activity event from the metadata blob', () => {
    const event = decodeProgressEvent(activityFields());
    expect(event?.kind).toBe('WorkflowTaskActivity');
    if (event?.kind !== 'WorkflowTaskActivity') throw new Error('expected activity');
    expect(event.payload).toMatchObject({
      runId: RUN_ID,
      taskId: 'implement',
      operationId: 'code.agent.run',
      stepName: 'Coding agent working',
      sequence: 2,
    });
    // An op task has no worker session — the field is omitted, not null.
    expect('workerSessionId' in event.payload).toBe(false);
  });

  it('returns null when the metadata carries no operationId', () => {
    const fields = activityFields({ metadata: JSON.stringify({ stepName: 'x' }) });
    expect(decodeProgressEvent(fields)).toBeNull();
  });

  it('returns null on a malformed metadata blob', () => {
    expect(decodeProgressEvent(activityFields({ metadata: '{not json' }))).toBeNull();
  });

  it('truncates stepDetail to 200 chars', () => {
    const long = 'x'.repeat(500);
    const fields = activityFields({
      metadata: JSON.stringify({ operationId: 'code.agent.run', stepDetail: long }),
    });
    const event = decodeProgressEvent(fields);
    if (event?.kind !== 'WorkflowTaskActivity') throw new Error('expected activity');
    expect(event.payload.stepDetail).toHaveLength(200);
  });

  it('falls back to the surface-update shape for a non-activity event', () => {
    const surfaceFields: Record<string, string> = {
      eventType: 'WorkflowTaskSurfaceUpdate',
      tenantId: 'tenant-1',
      runId: RUN_ID,
      taskId: 'render',
      stepExecutionId: 'step-2',
      surfaceId: 'surface-1',
      surfaceMutations: JSON.stringify([{ op: 'set' }]),
      sequence: '1',
    };
    const event = decodeProgressEvent(surfaceFields);
    expect(event?.kind).toBe('WorkflowTaskSurfaceUpdate');
  });

  it('drops a surface event missing its mutations (no eventType ⇒ default branch)', () => {
    expect(decodeProgressEvent({ runId: RUN_ID, taskId: 't' })).toBeNull();
  });
});

/**
 * The live-buffer wake shares the progress stream but not the progress plane:
 * it becomes a Pub/Sub signal, never a durable session event, and it carries
 * the step the reader goes to rather than any of the bytes.
 */
describe('decodeLiveDeltaWake', () => {
  function wakeFields(over: Record<string, string> = {}): Record<string, string> {
    return {
      eventType: 'WorkflowTaskLiveDelta',
      tenantId: 'tenant-1',
      runId: RUN_ID,
      taskId: 'review',
      stepExecutionId: 'step-1',
      attempt: '1',
      sequence: '0',
      metadata: JSON.stringify({ channel: 'activity' }),
      ...over,
    };
  }

  it('decodes the step, the run and the channel', () => {
    expect(decodeLiveDeltaWake(wakeFields())).toEqual({
      runId: RUN_ID,
      taskId: 'review',
      stepExecutionId: 'step-1',
      channel: 'activity',
    });
  });

  it('is not a progress event — the progress decoder refuses it', () => {
    expect(decodeProgressEvent(wakeFields())).toBeNull();
  });

  it('leaves every other event type to the progress decoder', () => {
    expect(decodeLiveDeltaWake(activityFields())).toBeNull();
  });

  it('refuses a channel the live plane does not have', () => {
    expect(
      decodeLiveDeltaWake(wakeFields({ metadata: JSON.stringify({ channel: 'invented' }) })),
    ).toBeNull();
  });

  it('refuses an entry naming no step', () => {
    const fields = wakeFields();
    delete fields['stepExecutionId'];
    expect(decodeLiveDeltaWake(fields)).toBeNull();
  });
});
