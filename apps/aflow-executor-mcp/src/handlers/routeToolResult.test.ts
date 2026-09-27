/**
 * mcp.tool.call result-routing.
 *
 * MCP returns `{ isError: true, content: [...] }` as a 200-shaped response
 * when the tool itself fails (auth, rate limit, business logic). If that
 * envelope flows through `successWithData`, the step finishes
 * `SUCCEEDED` and caller flows assume the call worked — e.g. a
 * submit-call task `succeeded` with output
 * `{"isError":true,"content":[{"text":"An error occurred invoking 'submit_to_competition'."}]}`,
 * eval criteria can't measure, downstream learnings are polluted.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { PayloadRef } from '@aflow/schemas';
import { mapToolResult, routeToolResult } from './mcpHandler.js';

function fakeCtx(): ExecutorContext {
  const writePayload = vi.fn(
    async (kind: string, data: unknown): Promise<PayloadRef> =>
      `inline:${Buffer.from(JSON.stringify({ kind, data })).toString('base64')}` as PayloadRef,
  );
  return { writePayload } as unknown as ExecutorContext;
}

describe('routeToolResult', () => {
  it('returns SUCCEEDED when isError is absent', async () => {
    const result = await routeToolResult(fakeCtx(), 'echo', {
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(result.status).toBe('SUCCEEDED');
  });

  it('returns SUCCEEDED when isError is explicitly false', async () => {
    const result = await routeToolResult(fakeCtx(), 'echo', {
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
    });
    expect(result.status).toBe('SUCCEEDED');
  });

  it('returns FAILED with provider classification when isError is true', async () => {
    const result = await routeToolResult(fakeCtx(), 'submit_to_competition', {
      content: [{ type: 'text', text: "An error occurred invoking 'submit_to_competition'." }],
      isError: true,
    });
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.classification).toBe('provider');
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toContain('submit_to_competition');
    expect(result.error.message).toContain("An error occurred invoking 'submit_to_competition'.");
    expect(result.error.details).toMatchObject({
      toolName: 'submit_to_competition',
      content: [{ type: 'text', text: "An error occurred invoking 'submit_to_competition'." }],
    });
  });

  it('handles isError with no text content gracefully', async () => {
    const result = await routeToolResult(fakeCtx(), 'opaque', {
      content: [],
      isError: true,
    });
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.message).toContain('with no text content');
  });

  it('records sentArgs on error and surfaces the key list in the message', async () => {
    // When the MCP server returns an opaque
    // generic error (Kaggle's "An error occurred invoking 'X'"), the only
    // actionable info left is what WE sent. Recording it on failure means
    // the operator can compare against the tool's documented schema.
    const result = await routeToolResult(
      fakeCtx(),
      'submit_to_competition',
      {
        content: [{ type: 'text', text: "An error occurred invoking 'submit_to_competition'." }],
        isError: true,
      },
      { fileContent: 'PassengerId,Survived\n892,0\n893,0\n', message: 'iteration 2' },
    );
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.message).toContain('sent args keys: fileContent, message');
    expect(result.error.details).toMatchObject({
      toolName: 'submit_to_competition',
      sentArgs: { fileContent: expect.stringContaining('PassengerId'), message: 'iteration 2' },
    });
  });

  it('truncates long string args in the recorded details', async () => {
    const longCsv = 'a,b,c\n' + '1,2,3\n'.repeat(200); // ~1.2KB > the 200-char cap
    const result = await routeToolResult(
      fakeCtx(),
      'submit_to_competition',
      {
        content: [{ type: 'text', text: 'fail' }],
        isError: true,
      },
      { fileContent: longCsv, message: 'short' },
    );
    if (result.status !== 'FAILED') return;
    const details = result.error.details as Record<string, unknown>;
    const sentArgs = details['sentArgs'] as { fileContent: string; message: string };
    expect(sentArgs.fileContent.length).toBeLessThan(longCsv.length);
    expect(sentArgs.fileContent).toContain('(truncated');
    expect(sentArgs.message).toBe('short');
  });

  it('omits sentArgs from details when not provided (back-compat)', async () => {
    const result = await routeToolResult(fakeCtx(), 't', {
      content: [{ type: 'text', text: 'fail' }],
      isError: true,
    });
    if (result.status !== 'FAILED') return;
    const details = result.error.details as Record<string, unknown>;
    expect(details).not.toHaveProperty('sentArgs');
    expect(result.error.message).not.toContain('sent args keys');
  });
});

// ============================================================================

describe('mapToolResult — structuredContent (Plan 194 §4.7)', () => {
  it('passes structuredContent through verbatim when the server returns an object', () => {
    const mapped = mapToolResult({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { publicScore: 0.124, status: 'COMPLETE' },
    });
    expect(mapped.structuredContent).toEqual({ publicScore: 0.124, status: 'COMPLETE' });
    expect(mapped.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('omits structuredContent when absent (no key, not undefined-valued)', () => {
    const mapped = mapToolResult({ content: [{ type: 'text', text: 'ok' }] });
    expect('structuredContent' in mapped).toBe(false);
  });

  it('drops non-object structuredContent shapes (arrays, primitives, null)', () => {
    expect('structuredContent' in mapToolResult({ content: [], structuredContent: [1] })).toBe(
      false,
    );
    expect('structuredContent' in mapToolResult({ content: [], structuredContent: 'x' })).toBe(
      false,
    );
    expect('structuredContent' in mapToolResult({ content: [], structuredContent: null })).toBe(
      false,
    );
  });

  it('keeps structuredContent alongside isError so failure routing still sees it', () => {
    const mapped = mapToolResult({
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
      structuredContent: { detail: 'rate_limited' },
    });
    expect(mapped.isError).toBe(true);
    expect(mapped.structuredContent).toEqual({ detail: 'rate_limited' });
  });

  it('flows through routeToolResult success unchanged (op output carries it)', async () => {
    const mapped = mapToolResult({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { token: 'blob-1' },
    });
    const result = await routeToolResult(fakeCtx(), 'start_upload', mapped);
    expect(result.status).toBe('SUCCEEDED');
  });
});
