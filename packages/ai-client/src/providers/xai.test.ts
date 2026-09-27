import { describe, it, expect } from 'vitest';
import type { SessionId, StepExecutionId, TenantId } from '@aflow/schemas';
import { AIClientError } from '../errors.js';
import type { EditImageRequest, GenerateImageRequest, ImageReferenceInput } from '../types.js';
import { createXaiAdapter } from './xai.js';

describe('xAI image routes refuse conditioning they cannot deliver', () => {
  const adapter = createXaiAdapter({ apiKey: 'not-a-real-key', maxRetries: 0, timeoutMs: 250 });

  const references: ImageReferenceInput[] = [
    { data: 'AAAA', mimeType: 'image/png', role: 'character', label: 'Ada' },
  ];

  const context = {
    tenantId: 'tenant' as TenantId,
    runId: 'run' as SessionId,
    stepExecutionId: 'step' as StepExecutionId,
  };

  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return await promise.then(
      () => {
        throw new Error('the call resolved instead of refusing');
      },
      (error: unknown) => error,
    );
  }

  it('refuses reference images on a generation', async () => {
    const request: GenerateImageRequest = {
      model: 'grok-imagine-image-2.0',
      prompt: 'Ada at the workbench',
      references,
      ...context,
    };
    const error = await rejection(adapter.generateImage!(request));
    expect(error).toBeInstanceOf(AIClientError);
    expect((error as AIClientError).code).toBe('invalid_request');
    expect((error as AIClientError).provider).toBe('xai');
  });

  it('refuses an inpaint mask on an edit', async () => {
    const request: EditImageRequest = {
      model: 'grok-imagine-image-2.0',
      prompt: 'put Ada at the workbench',
      imageData: 'BBBB',
      imageMimeType: 'image/png',
      maskData: 'CCCC',
      ...context,
    };
    const error = await rejection(adapter.editImage!(request));
    expect(error).toBeInstanceOf(AIClientError);
    expect((error as AIClientError).code).toBe('invalid_request');
    expect((error as AIClientError).provider).toBe('xai');
  });

  it('refuses an embedding request', async () => {
    const error = await rejection(
      adapter.generateEmbedding({
        model: 'grok-4.7',
        input: 'hello',
        ...context,
      }),
    );
    expect(error).toBeInstanceOf(AIClientError);
    expect((error as AIClientError).provider).toBe('xai');
  });
});
