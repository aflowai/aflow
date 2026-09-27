/**
 * Tests for the shared error normalizers — pin retryability for transient
 * network failures and aborts so the orchestrator's retry budget actually
 * fires.
 */
import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildStreamTruncationError,
  normalizeAnthropicError,
  normalizeOpenAIError,
} from './errors.js';

describe('normalizeAnthropicError', () => {
  it('marks Anthropic SDK "Connection error." as retryable', () => {
    const sdkError = new Error('Connection error.');
    const normalized = normalizeAnthropicError(sdkError);
    expect(normalized.retryable).toBe(true);
    expect(normalized.code).toBe('provider_error');
  });

  it('marks APIConnectionError (by error.name) as retryable', () => {
    const sdkError = new Error('socket hang up');
    sdkError.name = 'APIConnectionError';
    const normalized = normalizeAnthropicError(sdkError);
    expect(normalized.retryable).toBe(true);
  });

  it('marks APIConnectionTimeoutError as retryable', () => {
    const sdkError = new Error('Request timed out');
    sdkError.name = 'APIConnectionTimeoutError';
    const normalized = normalizeAnthropicError(sdkError);
    expect(normalized.retryable).toBe(true);
  });

  it('marks 502/503/504 status as retryable', () => {
    for (const status of [502, 503, 504]) {
      const err = new Error(`HTTP ${String(status)}`);
      (err as unknown as Record<string, unknown>)['status'] = status;
      expect(normalizeAnthropicError(err).retryable).toBe(true);
    }
  });

  it('marks rate_limit (429) as retryable', () => {
    const err = new Error('rate_limit_exceeded');
    (err as unknown as Record<string, unknown>)['status'] = 429;
    expect(normalizeAnthropicError(err).retryable).toBe(true);
  });

  it('marks 401/403 (auth) as NOT retryable', () => {
    for (const status of [401, 403]) {
      const err = new Error('unauthorized');
      (err as unknown as Record<string, unknown>)['status'] = status;
      expect(normalizeAnthropicError(err).retryable).toBe(false);
    }
  });

  it('does NOT match unrelated 4xx that happens to mention connection', () => {
    // Defensive: the "Connection error." match is exact-message to avoid
    // false positives on 4xx errors with similar wording.
    const err = new Error('Bad request: invalid connection parameter');
    (err as unknown as Record<string, unknown>)['status'] = 400;
    expect(normalizeAnthropicError(err).retryable).toBe(false);
  });

  it('marks aborted/timeout messages as retryable', () => {
    expect(normalizeAnthropicError(new Error('request aborted')).retryable).toBe(true);
    expect(normalizeAnthropicError(new Error('Request timeout')).retryable).toBe(true);
  });

  it('classifies SDK APIUserAbortError as retryable timeout', () => {
    const normalized = normalizeAnthropicError(new Anthropic.APIUserAbortError());
    expect(normalized.code).toBe('timeout');
    expect(normalized.retryable).toBe(true);
  });
});

describe('normalizeOpenAIError', () => {
  it('classifies SDK APIUserAbortError as retryable timeout', () => {
    const normalized = normalizeOpenAIError(new OpenAI.APIUserAbortError());
    expect(normalized.code).toBe('timeout');
    expect(normalized.retryable).toBe(true);
  });

  it('classifies fetch AbortError as retryable timeout', () => {
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    const normalized = normalizeOpenAIError(err);
    expect(normalized.code).toBe('timeout');
    expect(normalized.retryable).toBe(true);
  });

  it('classifies SDK APIConnectionTimeoutError as retryable timeout', () => {
    const normalized = normalizeOpenAIError(new OpenAI.APIConnectionTimeoutError());
    expect(normalized.code).toBe('timeout');
    expect(normalized.retryable).toBe(true);
  });

  it('classifies SDK APIConnectionError as retryable network error', () => {
    // Non-default message: the SDK leaves `.name` as 'Error', so this only
    // passes via the constructor-name check, not the exact-message fallback.
    const normalized = normalizeOpenAIError(
      new OpenAI.APIConnectionError({ message: 'socket hang up' }),
    );
    expect(normalized.code).toBe('network_error');
    expect(normalized.retryable).toBe(true);
  });

  it('marks 401/403 (auth) as NOT retryable', () => {
    for (const status of [401, 403]) {
      const err = new Error('unauthorized');
      (err as unknown as Record<string, unknown>)['status'] = status;
      expect(normalizeOpenAIError(err).retryable).toBe(false);
    }
  });

  it('keeps auth classification for 401s whose message mentions abort', () => {
    const err = new Error('request aborted: invalid API key');
    (err as unknown as Record<string, unknown>)['status'] = 401;
    const normalized = normalizeOpenAIError(err);
    expect(normalized.code).toBe('auth');
    expect(normalized.retryable).toBe(false);
  });

  it('keeps status-based classification for HTTP errors that mention abort', () => {
    const err = new Error('request aborted by upstream policy');
    (err as unknown as Record<string, unknown>)['status'] = 400;
    const normalized = normalizeOpenAIError(err);
    expect(normalized.code).toBe('provider_error');
    expect(normalized.retryable).toBe(false);
  });
});

describe('buildStreamTruncationError', () => {
  it('classifies a spontaneous stream end without finish_reason as retryable network_error', () => {
    const err = buildStreamTruncationError({
      provider: 'fireworks',
      model: 'accounts/fireworks/models/glm-5p3',
      startMs: Date.now() - 5_000,
      accumulatedChars: 4200,
      toolCallCount: 0,
    });
    expect(err.code).toBe('network_error');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('stream ended without finish_reason');
    expect(err.message).toContain('4200 content chars');
    expect(err.message).toContain('response truncated mid-generation');
  });

  it('reports a platform timeout when the abort signal carries the executor marker', () => {
    const controller = new AbortController();
    controller.abort({ marker: 'phoenix.executor.timeout', timeoutMs: 120_000 });
    const err = buildStreamTruncationError({
      provider: 'fireworks',
      model: 'accounts/fireworks/models/glm-5p3',
      signal: controller.signal,
      startMs: Date.now() - 120_000,
      accumulatedChars: 4200,
      toolCallCount: 1,
    });
    expect(err.code).toBe('timeout');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('Platform timeout exceeded after 120000ms mid-stream');
    expect(err.message).toContain('partial response discarded');
  });

  it('an aborted signal without the marker still classifies as truncation, not platform timeout', () => {
    const controller = new AbortController();
    controller.abort();
    const err = buildStreamTruncationError({
      provider: 'openrouter',
      model: 'some/model',
      signal: controller.signal,
      startMs: Date.now(),
      accumulatedChars: 0,
      toolCallCount: 0,
    });
    expect(err.code).toBe('network_error');
    expect(err.retryable).toBe(true);
  });
});
