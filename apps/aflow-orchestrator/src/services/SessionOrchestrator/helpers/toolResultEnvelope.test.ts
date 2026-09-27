import { describe, it, expect } from 'vitest';
import type { AflowError } from '@aflow/schemas';
import { AiToolResultEnvelopeV1Schema, toAgentToolError } from '@aflow/schemas';
import { buildToolResultEnvelopes } from './toolResultEnvelope.js';
import type { ToolResultSummary } from '../types.js';

const strictEnvelope = AiToolResultEnvelopeV1Schema.strict();

describe('buildToolResultEnvelopes (Plan 196 §4.4a)', () => {
  it('graph tool: toolId is the stepId — operationId carries the executed catalog op', () => {
    const summary: ToolResultSummary = {
      toolCallId: 'abc123_0',
      toolId: 'step-fetch-data',
      name: 'step-fetch-data',
      status: 'SUCCEEDED',
      summary: 'fetched 42 rows',
      operationId: 'api.http.call',
      outputStoredIn: ['rows'],
      displayedToUser: false,
      durationMs: 1200,
      hasOutputRef: true,
      outputFields: ['data', 'headers'],
      nextSteps: [{ action: 'memory.store.put', note: 'persist the rows' }],
    };

    const [envelope] = buildToolResultEnvelopes([summary], 1_718_000_000_000);
    expect(envelope).toBeDefined();

    const parsed = strictEnvelope.safeParse(envelope);
    expect(parsed.success).toBe(true);

    expect(envelope!.operationId).toBe('api.http.call');
    expect(envelope!.outputPath).toBe('/run/outputs/abc123_0');
    expect(envelope!.outputFields).toEqual(['data', 'headers']);
    expect(envelope!.completedAtMs).toBe(1_718_000_000_000);
    expect('toolId' in envelope!).toBe(false);
    expect('outputStoredInPreview' in envelope!).toBe(false);
  });

  it('virtual tool: toolId and operationId are the same catalog id', () => {
    const [envelope] = buildToolResultEnvelopes(
      [
        {
          toolCallId: 'def456_0',
          toolId: 'compute.sandbox.exec',
          name: 'compute.sandbox.exec',
          status: 'SUCCEEDED',
          summary: 'ran',
          operationId: 'compute.sandbox.exec',
        },
      ],
      1,
    );
    expect(strictEnvelope.safeParse(envelope).success).toBe(true);
    expect(envelope!.operationId).toBe('compute.sandbox.exec');
    expect(envelope!.outputPath).toBeUndefined();
  });

  it('FAILED non-retryable: typed error + pause hint, no summary', () => {
    const [envelope] = buildToolResultEnvelopes(
      [
        {
          toolCallId: 'ghi789_0',
          toolId: 'step-train',
          name: 'step-train',
          status: 'FAILED',
          summary: 'should be dropped in favor of error',
          operationId: 'compute.sandbox.exec',
          error: { error: 'unavailable', message: 'OOM', retry: false },
        },
      ],
      2,
    );
    expect(strictEnvelope.safeParse(envelope).success).toBe(true);
    expect(envelope!.error?.message).toBe('OOM');
    expect(envelope!.summary).toBeUndefined();
    expect(envelope!.nextExpectedFromAgent?.[0]?.action).toBe('pause_for_input');
  });

  it('FAILED retryable: suggests retry with corrected arguments', () => {
    const [envelope] = buildToolResultEnvelopes(
      [
        {
          toolCallId: 'err001_0',
          toolId: 'memory.store.get',
          name: 'memory.store.get',
          status: 'FAILED',
          operationId: 'memory.store.get',
          error: {
            error: 'not_found',
            message: "field '/data' not in output",
            retry: true,
          },
        },
      ],
      3,
    );
    expect(strictEnvelope.safeParse(envelope).success).toBe(true);
    expect(envelope!.nextExpectedFromAgent?.[0]?.action).toBe('retry');
    expect(envelope!.nextExpectedFromAgent?.[0]?.note).toContain('Correct the arguments');
  });

  it('omits operationId when the summary has none (legacy/unresolvable) — lookup degrades to unknown', () => {
    const [envelope] = buildToolResultEnvelopes(
      [{ toolCallId: 'jkl000_0', toolId: 'step-x', name: 'step-x', status: 'SUCCEEDED' }],
      3,
    );
    expect(strictEnvelope.safeParse(envelope).success).toBe(true);
    expect('operationId' in envelope!).toBe(false);
  });

  // Guard: the structured payload of a rejected applet action must survive the
  // whole tool-result path — toAgentToolError, the envelope build, and the wire
  // parse the AI executor applies (AiToolResultEnvelopeV1Schema).
  it('applet rejection: {reason, availableActions, validation} round-trips into the parsed envelope', () => {
    const details = {
      reason: 'input_invalid',
      availableActions: ['move', 'resign', 'raw_patch'],
      validation: [{ path: ['from'], message: 'Required' }],
    };
    const aflowError: AflowError = {
      code: 'VALIDATION_ERROR',
      message: "Action 'move' rejected: input does not match the action schema",
      classification: 'validation',
      retryable: false,
      details,
      timestamp: new Date().toISOString(),
    };

    const [envelope] = buildToolResultEnvelopes(
      [
        {
          toolCallId: 'act001_0',
          toolId: 'chess.move',
          name: 'chess.move',
          status: 'FAILED',
          operationId: 'ui.applet.act',
          error: toAgentToolError(aflowError),
        },
      ],
      4,
    );

    const parsed = strictEnvelope.safeParse(envelope);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.error?.details).toEqual(details);
    expect(parsed.success && parsed.data.error?.error).toBe('validation');
    expect(parsed.success && parsed.data.error?.retry).toBe(true);
  });

  it('applet version conflict: type conflict, retry true, currentVersion in the parsed envelope', () => {
    const aflowError: AflowError = {
      code: 'APPLET_VERSION_CONFLICT',
      message:
        'Stale baseVersion — the instance is at version 9. Re-read with ui.applet.get and recompute before retrying.',
      classification: 'conflict',
      retryable: true,
      details: { currentVersion: 9 },
      timestamp: new Date().toISOString(),
    };

    const [envelope] = buildToolResultEnvelopes(
      [
        {
          toolCallId: 'act002_0',
          toolId: 'chess.move',
          name: 'chess.move',
          status: 'FAILED',
          operationId: 'ui.applet.act',
          error: toAgentToolError(aflowError),
        },
      ],
      5,
    );

    const parsed = strictEnvelope.safeParse(envelope);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.error?.error).toBe('conflict');
    expect(parsed.success && parsed.data.error?.retry).toBe(true);
    expect(parsed.success && parsed.data.error?.details).toEqual({ currentVersion: 9 });
    expect(parsed.success && parsed.data.error?.message).toContain(
      'Re-read with ui.applet.get and recompute',
    );
    expect(parsed.success && parsed.data.nextExpectedFromAgent?.[0]?.action).toBe('retry');
  });
});
