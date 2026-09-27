/**
 * What the image lanes quote a render at before dispatching it.
 *
 * The quote is priced against a quantity the caller names, and a quantity
 * nobody names is unpriced rather than free. The candidate count is the one
 * quantity an image request can leave out, so the omitted case is the one that
 * decides whether an ordinary render reports a price at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import type { AiImageEditInput, AiImageGenerateInput, TenantId } from '@aflow/schemas';
import { getAIClientForContext } from '../aiClient.js';
import { deliverImages, type DeliverImagesParams } from './imageDeliver.js';
import { handleImageGenerate } from './imageGenerate.js';
import { handleImageEdit } from './imageEdit.js';
import type { HandlerDeps } from './types.js';

vi.mock('../aiClient.js', () => ({ getAIClientForContext: vi.fn() }));
vi.mock('./imageDeliver.js', () => ({ deliverImages: vi.fn() }));

const PRICE_PER_IMAGE_USD = 0.04;
const MICROS_PER_UNIT = 1_000_000;

const generateImage = vi.fn();
const editImage = vi.fn();

function stubClient(): void {
  vi.mocked(getAIClientForContext).mockResolvedValue({
    resolveModelId: () => 'gpt-image-1.5',
    getAdapter: () => Promise.resolve({ generateImage, editImage, provider: 'openai' }),
    getModel: () => ({ capabilities: { imageGeneration: true } }),
    listModels: () => [],
    modelCatalog: {
      getModel: () => ({ pricing: { imagePerImage: PRICE_PER_IMAGE_USD } }),
      calculateCost: (_model: string, usage: { imageCount?: number }) => ({
        mediaCost: PRICE_PER_IMAGE_USD * (usage.imageCount ?? 0),
        currency: 'USD',
      }),
    },
  } as never);
}

function fakeCtx(): ExecutorContext {
  return {
    job: {
      tenantId: 'tenant-quote',
      spaceId: 'space-quote',
      stepId: 'render',
      stepExecutionId: 'step-quote',
      attempt: 1,
    },
    tenantId: 'tenant-quote' as TenantId,
    spaceId: 'space-quote',
    runId: 'run-quote',
    stepExecutionId: 'step-quote',
    logicalExecutionId: 'step:step-quote',
    attempt: 1,
    operationId: 'ai.media.image',
    log: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    readPayload: () => Promise.resolve({ data: 'AAAA', mimeType: 'image/png' }),
  } as unknown as ExecutorContext;
}

const deps = {
  payloadStore: {} as HandlerDeps['payloadStore'],
  db: {} as NonNullable<HandlerDeps['db']>,
  handleError: (_ctx: ExecutorContext, label: string, error: unknown) => {
    throw new Error(`${label}: ${String(error)}`);
  },
  validateToolArgs: () => null,
} satisfies HandlerDeps;

function quotedMicros(): number | undefined {
  const call = vi.mocked(deliverImages).mock.calls[0]?.[0] as DeliverImagesParams | undefined;
  return call?.quoted?.micros;
}

function renderedImages(count: number): { images: unknown[]; provider: string; model: string } {
  return {
    images: Array.from({ length: count }, () => ({ data: 'BBBB', mimeType: 'image/png' })),
    provider: 'openai',
    model: 'gpt-image-1.5',
  };
}

describe('the image quote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubClient();
    vi.mocked(deliverImages).mockResolvedValue({} as StepResult);
  });

  it('prices the single render an omitted candidate count asks for', async () => {
    generateImage.mockResolvedValue(renderedImages(1));

    await handleImageGenerate(fakeCtx(), { prompt: 'Ada at the workbench' }, deps);

    expect(
      quotedMicros(),
      'an unnamed quantity is unpriced, so the ordinary one-image call would report that nothing priced it',
    ).toBe(PRICE_PER_IMAGE_USD * MICROS_PER_UNIT);
  });

  it('prices the candidate count the request did name', async () => {
    generateImage.mockResolvedValue(renderedImages(3));

    const params: AiImageGenerateInput = { prompt: 'Ada at the workbench', n: 3 };
    await handleImageGenerate(fakeCtx(), params, deps);

    expect(quotedMicros()).toBe(3 * PRICE_PER_IMAGE_USD * MICROS_PER_UNIT);
  });

  it('prices an edit that names no candidate count the same way', async () => {
    editImage.mockResolvedValue(renderedImages(1));

    const params: AiImageEditInput = { prompt: 'brighten the sky', imageRef: 'payload:t:abc' };
    await handleImageEdit(fakeCtx(), params, deps);

    expect(quotedMicros()).toBe(PRICE_PER_IMAGE_USD * MICROS_PER_UNIT);
  });
});
