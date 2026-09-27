/**
 * Tests for `normalizeOpenRouterError` — pin abort classification. SDK aborts
 * (APIUserAbortError) extend APIError, so without an early abort branch they
 * fall into the status-based tail as a terminal provider error.
 */
import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { AIClientError } from '../errors.js';
import { choicesOrThrow, normalizeOpenRouterError } from './openrouter.js';

describe('normalizeOpenRouterError', () => {
  it('classifies SDK APIUserAbortError as retryable timeout with diagnostics', () => {
    const normalized = normalizeOpenRouterError(new OpenAI.APIUserAbortError(), {
      model: 'moonshotai/kimi-k2.6',
      startMs: Date.now(),
    });
    expect(normalized.code).toBe('timeout');
    expect(normalized.retryable).toBe(true);
    expect(normalized.message).toContain('Request aborted');
    expect(normalized.message).toContain('sdkErrorClass=APIUserAbortError');
    expect(normalized.message).toContain('model=moonshotai/kimi-k2.6');
  });

  it('reports a platform timeout when the signal carries the executor marker', () => {
    const controller = new AbortController();
    controller.abort({ marker: 'phoenix.executor.timeout', timeoutMs: 30_000 });
    const normalized = normalizeOpenRouterError(new OpenAI.APIUserAbortError(), {
      model: 'moonshotai/kimi-k2.6',
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
    const normalized = normalizeOpenRouterError(err);
    expect(normalized.code).toBe('timeout');
    expect(normalized.retryable).toBe(true);
  });

  it('keeps status-based classification for HTTP errors that mention abort', () => {
    const message = 'request aborted by upstream policy';
    const apiError = new OpenAI.APIError(400, { message }, message, undefined);
    const normalized = normalizeOpenRouterError(apiError);
    expect(normalized.code).toBe('invalid_request');
    expect(normalized.retryable).toBe(false);
  });

  it('marks connection timeouts as retryable timeout', () => {
    const normalized = normalizeOpenRouterError(new OpenAI.APIConnectionTimeoutError());
    expect(normalized.code).toBe('timeout');
    expect(normalized.retryable).toBe(true);
  });
});

describe('choicesOrThrow', () => {
  const withChoices = {
    id: 'gen-1',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  } as unknown as OpenAI.ChatCompletion;

  /** OpenRouter answers a routing refusal with 200 + `error`, and no `choices`. */
  const routingRefusal = {
    id: 'gen-2',
    error: {
      message: 'No endpoints available matching your guardrail restrictions and data policy.',
      code: 404,
    },
  } as unknown as OpenAI.ChatCompletion;

  it('returns the choices when the body carries them', () => {
    expect(choicesOrThrow(withChoices, 'deepseek/deepseek-v4-flash')).toHaveLength(1);
  });

  it('surfaces a 200-carried routing refusal as a terminal error, not a network fault', () => {
    let thrown: unknown;
    try {
      choicesOrThrow(routingRefusal, 'deepseek/deepseek-v4-flash');
    } catch (err) {
      thrown = err;
    }
    const error = thrown as AIClientError;
    expect(error).toBeInstanceOf(AIClientError);
    expect(error.code).toBe('model_not_found');
    // The whole point: a retryable classification loops on a request that can
    // never succeed and buries the reason.
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('guardrail restrictions');
    expect(error.message).toContain('deepseek/deepseek-v4-flash');
  });

  it('keeps an undiagnosed empty body retryable', () => {
    let thrown: unknown;
    try {
      choicesOrThrow({ id: 'gen-3' } as unknown as OpenAI.ChatCompletion, 'some/model');
    } catch (err) {
      thrown = err;
    }
    const error = thrown as AIClientError;
    expect(error.code).toBe('provider_error');
    expect(error.retryable).toBe(true);
  });
});
