import { describe, it, expect } from 'vitest';
import type { SessionId, StepExecutionId, TenantId } from '@aflow/schemas';
import { AIClientError } from '../errors.js';
import type { EditImageRequest, GenerateImageRequest, ImageReferenceInput } from '../types.js';
import { createOpenAIAdapter, mapOpenAiReasoningEffort } from './openai.js';

describe('mapOpenAiReasoningEffort — Plan 259 parity', () => {
  it('returns undefined when no reasoning config is supplied (provider default)', () => {
    expect(mapOpenAiReasoningEffort(undefined)).toBeUndefined();
  });

  it('maps effort "off" to "none"', () => {
    expect(mapOpenAiReasoningEffort({ effort: 'off' })).toBe('none');
  });

  it.each(['low', 'medium', 'high'] as const)('passes effort "%s" through', (effort) => {
    expect(mapOpenAiReasoningEffort({ effort })).toBe(effort);
  });

  it('returns undefined when effort is unset on a present config', () => {
    expect(mapOpenAiReasoningEffort({})).toBeUndefined();
  });
});

describe('OpenAI image routes refuse reference images', () => {
  // Aimed at a closed port with no retries, so the refusal is the only way this
  // resolves without touching the network: a route that lets references through
  // rejects with a connection error instead of the code asserted below.
  const adapter = createOpenAIAdapter({
    apiKey: 'not-a-real-key',
    baseUrl: 'http://127.0.0.1:1/v1',
    maxRetries: 0,
    timeoutMs: 250,
  });

  const references: ImageReferenceInput[] = [
    { data: 'AAAA', mimeType: 'image/png', role: 'character', label: 'Ada' },
  ];

  const context = {
    tenantId: 'tenant' as TenantId,
    runId: 'run' as SessionId,
    stepExecutionId: 'step' as StepExecutionId,
  };

  const generation: GenerateImageRequest = {
    model: 'gpt-image-1',
    prompt: 'Ada at the workbench',
    references,
    ...context,
  };

  const edit: EditImageRequest = {
    model: 'gpt-image-1',
    prompt: 'put Ada at the workbench',
    imageData: 'BBBB',
    imageMimeType: 'image/png',
    references,
    ...context,
  };

  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return await promise.then(
      () => {
        throw new Error('the call resolved instead of refusing the references');
      },
      (error: unknown) => error,
    );
  }

  it('refuses them on a generation', async () => {
    const error = await rejection(adapter.generateImage!(generation));
    expect(error).toBeInstanceOf(AIClientError);
    expect((error as AIClientError).code).toBe('invalid_request');
    expect((error as AIClientError).retryable).toBe(false);
  });

  it('refuses them on an edit', async () => {
    const error = await rejection(adapter.editImage!(edit));
    expect(error).toBeInstanceOf(AIClientError);
    expect((error as AIClientError).code).toBe('invalid_request');
    expect((error as AIClientError).retryable).toBe(false);
  });

  it('leaves an edit without references alone', async () => {
    // Same route, no references: it reaches the network and fails there, which
    // is what proves the two refusals above are about the references.
    const error = await rejection(adapter.editImage!({ ...edit, references: undefined }));
    expect(error).toBeInstanceOf(AIClientError);
    expect((error as AIClientError).code).not.toBe('invalid_request');
  });
});
