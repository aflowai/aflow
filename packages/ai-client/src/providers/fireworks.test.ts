/**
 * Tests for `normalizeFireworksError` — pin abort classification. SDK aborts
 * (APIUserAbortError) extend APIError, so without an early abort branch they
 * fall into the status-based tail as a terminal provider error.
 */
import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { normalizeFireworksError, toOpenAIMessage } from './fireworks.js';

describe('normalizeFireworksError', () => {
  it('classifies SDK APIUserAbortError as retryable timeout with diagnostics', () => {
    const normalized = normalizeFireworksError(new OpenAI.APIUserAbortError(), {
      model: 'accounts/fireworks/models/kimi-k3',
      startMs: Date.now(),
    });
    expect(normalized.code).toBe('timeout');
    expect(normalized.retryable).toBe(true);
    expect(normalized.message).toContain('Fireworks request aborted');
    expect(normalized.message).toContain('sdkErrorClass=APIUserAbortError');
    expect(normalized.message).toContain('model=accounts/fireworks/models/kimi-k3');
  });

  it('reports a platform timeout when the signal carries the executor marker', () => {
    const controller = new AbortController();
    controller.abort({ marker: 'phoenix.executor.timeout', timeoutMs: 30_000 });
    const normalized = normalizeFireworksError(new OpenAI.APIUserAbortError(), {
      model: 'accounts/fireworks/models/kimi-k3',
      signal: controller.signal,
    });
    expect(normalized.code).toBe('timeout');
    expect(normalized.retryable).toBe(true);
    expect(normalized.message).toContain('Platform timeout exceeded after 30000ms');
    expect(normalized.message).toContain('sdkErrorClass=APIUserAbortError');
  });

  it('classifies fetch AbortError as retryable timeout', () => {
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    const normalized = normalizeFireworksError(err);
    expect(normalized.code).toBe('timeout');
    expect(normalized.retryable).toBe(true);
  });

  it('keeps status-based classification for HTTP errors that mention abort', () => {
    const message = 'request aborted by upstream policy';
    const apiError = new OpenAI.APIError(400, { message }, message, undefined);
    const normalized = normalizeFireworksError(apiError);
    expect(normalized.code).toBe('invalid_request');
    expect(normalized.retryable).toBe(false);
  });

  it('marks connection timeouts as retryable timeout', () => {
    const normalized = normalizeFireworksError(new OpenAI.APIConnectionTimeoutError());
    expect(normalized.code).toBe('timeout');
    expect(normalized.retryable).toBe(true);
  });
});

describe('toOpenAIMessage — reasoning_content continuity replay (Plan 259)', () => {
  it('replays reasoning_content on the assistant message when captured for fireworks', () => {
    const msg = toOpenAIMessage({
      role: 'assistant',
      content: 'answer',
      toolCalls: [{ id: 'a_0', type: 'function', function: { name: 'q', arguments: '{}' } }],
      providerReasoning: {
        provider: 'fireworks',
        model: 'glm-5.2',
        blocks: [{ reasoning_content: 'step-by-step reasoning' }],
      },
    }) as Record<string, unknown>;
    expect(msg['reasoning_content']).toBe('step-by-step reasoning');
    expect(msg['role']).toBe('assistant');
  });

  it('omits reasoning_content when there is no captured reasoning', () => {
    const msg = toOpenAIMessage({
      role: 'assistant',
      content: 'answer',
    }) as Record<string, unknown>;
    expect('reasoning_content' in msg).toBe(false);
  });

  it('never replays another provider’s reasoning', () => {
    const msg = toOpenAIMessage({
      role: 'assistant',
      content: 'answer',
      providerReasoning: {
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        blocks: [{ type: 'thinking', thinking: 'x', signature: 's' }],
      },
    }) as Record<string, unknown>;
    expect('reasoning_content' in msg).toBe(false);
  });
});
