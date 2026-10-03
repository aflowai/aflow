import { describe, it, expect } from 'vitest';
import { ApiSessionEventSchema, ApiSessionEventDataSchema } from '../runtime/apiEvents.js';

describe('ApiSessionEventSchema (Plan 56)', () => {
  it('has a stable set of top-level keys', () => {
    const keys = Object.keys(ApiSessionEventSchema.shape).sort();
    expect(keys).toMatchInlineSnapshot(`
      [
        "data",
        "eventId",
        "eventType",
        "eventVersion",
        "metadata",
        "sequenceNumber",
        "sessionId",
        "stepExecutionId",
        "surfaceId",
        "surfaceMutations",
        "timestamp",
        "usage",
        "usageSummary",
      ]
    `);
  });

  it('has a stable set of data keys', () => {
    const keys = Object.keys(ApiSessionEventDataSchema.shape).sort();
    expect(keys).toMatchInlineSnapshot(`
      [
        "attempt",
        "errorRef",
        "outputVariables",
        "pauseContract",
        "payloadRef",
        "presentation",
        "requestedInputRef",
        "runtimeStatePatch",
        "stepId",
        "stepType",
        "workflowRunUpdate",
        "workflowTaskActivity",
        "workflowTaskSurfaceUpdate",
        "workflowTaskUpdate",
      ]
    `);
  });

  it('validates a fully-populated event', () => {
    const event = {
      eventId: 'evt-001',
      eventType: 'StepSucceeded',
      sessionId: '00000000-0000-0000-0000-000000000001',
      stepExecutionId: '00000000-0000-0000-0000-000000000002',
      timestamp: '2026-03-16T00:00:00.000Z',
      sequenceNumber: 42,
      eventVersion: 1,
      data: {
        stepId: 'step-1',
        stepType: 'ai',
        attempt: 1,
        payloadRef: 'inline:output:abc123',
        errorRef: undefined,
        requestedInputRef: undefined,
        runtimeStatePatch: {
          version: 3,
          changed: [{ key: 'result', value: 'hello' }],
        },
        outputVariables: [{ key: 'answer', name: 'Answer', value: 'hello', semanticType: 'text' }],
      },
      metadata: { stepName: 'Generate response' },
      usage: {
        provider: 'openai',
        model: 'gpt-6.1-sol',
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        promptCostUsd: 0.001,
        completionCostUsd: 0.002,
        totalCostUsd: 0.003,
      },
      usageSummary: {
        totalPromptTokens: 200,
        totalCompletionTokens: 100,
        totalTokens: 300,
        totalCostUsd: 0.006,
        models: ['gpt-6.1-sol'],
      },
      surfaceMutations: [{ op: 'append', path: '/items', value: { text: 'hi' } }],
      surfaceId: 'surface-1',
    };

    const result = ApiSessionEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it('validates a minimal event (only required fields)', () => {
    const event = {
      eventId: 'evt-002',
      eventType: 'FlowRunQueued',
      sessionId: '00000000-0000-0000-0000-000000000001',
      timestamp: '2026-03-16T00:00:00.000Z',
      sequenceNumber: 0,
      eventVersion: 1,
      data: {},
    };

    const result = ApiSessionEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });
});
