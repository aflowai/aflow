/**
 * What the image lane — generation and editing both — refuses before it spends
 * anything. Every case here fails ahead of the route call, so none of them
 * needs a place to store bytes; the lane's storage path has its own coverage
 * against a real database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import type { AiImageEditInput, AiImageGenerateInput } from '@aflow/schemas';
import { handleImageGenerate } from './imageGenerate.js';
import { handleImageEdit } from './imageEdit.js';
import type { HandlerDeps } from './types.js';
import { getAIClientForContext } from '../aiClient.js';

vi.mock('../aiClient.js', () => ({
  getAIClientForContext: vi.fn(),
}));

const REFERENCE_CAPABLE = 'google-pro-image';
const REFERENCE_BLIND = 'gpt-image';

function makeCtx(): ExecutorContext {
  return {
    job: {
      tenantId: 'tenant-test',
      spaceId: 'space-test',
      runId: 'run-test',
      stepId: 'img-1',
      stepExecutionId: 'sx-1',
      attempt: 1,
    },
    tenantId: 'tenant-test',
    spaceId: 'space-test',
    runId: 'run-test',
    logicalExecutionId: 'step:sx-1',
    operationId: 'ai.media.image',
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    writePayload: vi.fn().mockResolvedValue('inline:test'),
    readPayload: vi.fn().mockResolvedValue({ data: 'AAAA', mimeType: 'image/png' }),
  } as unknown as ExecutorContext;
}

/** Storage resolves but is never written to: every case here refuses first. */
function makeDeps(): HandlerDeps {
  return { ...makeDepsWithoutStorage(), db: {} as PostgresJsDatabase };
}

function makeDepsWithoutStorage(): HandlerDeps {
  return {
    payloadStore: createMemoryPayloadStore(),
    handleError: vi.fn().mockImplementation(async (_c, _l, error: unknown) => {
      throw error;
    }),
    validateToolArgs: () => null,
  };
}

const generateImage = vi.fn();
const editImage = vi.fn();

function stubClient(): void {
  vi.mocked(getAIClientForContext).mockResolvedValue({
    resolveModelId: (key: string) =>
      key === REFERENCE_CAPABLE ? 'gemini-3-pro-image' : 'gpt-image-2.5-sunburst',
    getAdapter: () => Promise.resolve({ generateImage, editImage }),
    getModel: (key: string) =>
      key === REFERENCE_CAPABLE
        ? { capabilities: { imageGeneration: true, imageReferences: { character: 5, style: 3 } } }
        : { capabilities: { imageGeneration: true } },
    modelCatalog: { getModel: () => undefined, calculateCost: () => undefined },
    listModels: () => [
      {
        id: 'gemini-3-pro-image',
        aliases: ['pro-image', REFERENCE_CAPABLE],
        capabilities: { imageGeneration: true, imageReferences: { character: 5, style: 3 } },
      },
      {
        id: 'gpt-image-2.5-sunburst',
        aliases: [REFERENCE_BLIND],
        capabilities: { imageGeneration: true },
      },
      // A video route declares references of its own. Suggesting it to an image
      // caller would name a model that cannot answer the request at all.
      {
        id: 'klingai:kling-video@3-standard',
        aliases: ['runware-kling'],
        capabilities: { videoGeneration: true, imageReferences: { character: 12, style: 0 } },
      },
    ],
  } as never);
}

function input(overrides: Partial<AiImageGenerateInput> = {}): AiImageGenerateInput {
  return { prompt: 'Ada at the workbench', ...overrides };
}

function editInput(): AiImageEditInput {
  return { prompt: 'brighten the background', imageRef: 'inline:source', model: REFERENCE_CAPABLE };
}

describe('the image lane — what it refuses before it spends', () => {
  beforeEach(() => {
    vi.mocked(getAIClientForContext).mockReset();
    generateImage.mockReset();
    editImage.mockReset();
    generateImage.mockResolvedValue({
      images: [{ data: 'BBBB', mimeType: 'image/png' }],
      model: 'gemini-3-pro-image',
      provider: 'google',
    });
    stubClient();
  });

  it('refuses a render it has nowhere to file rather than paying for it', async () => {
    const result = await handleImageGenerate(
      makeCtx(),
      input({ model: REFERENCE_CAPABLE }),
      makeDepsWithoutStorage(),
    );

    expect(result.status).toBe('FAILED');
    expect(generateImage).not.toHaveBeenCalled();
  });

  it('refuses an edit it has nowhere to file rather than paying for it', async () => {
    const result = await handleImageEdit(makeCtx(), editInput(), makeDepsWithoutStorage());

    expect(result.status).toBe('FAILED');
    expect(editImage).not.toHaveBeenCalled();
  });

  it('fails a reference-blind model naming one that accepts references', async () => {
    const result = await handleImageGenerate(
      makeCtx(),
      input({ model: REFERENCE_BLIND, referenceRefs: [{ ref: 'inline:ada', role: 'character' }] }),
      makeDeps(),
    );

    expect(result.status).toBe('FAILED');
    expect(generateImage).not.toHaveBeenCalled();
    const message = result.status === 'FAILED' ? result.error.message : '';
    expect(message).toContain(REFERENCE_CAPABLE);
    // Every name offered has to be one this operation could actually run, and
    // spelled the way its own schema spells it.
    expect(message).not.toContain('kling');
  });

  it('fails when the resolved model honours fewer references of a role than were supplied', async () => {
    const result = await handleImageGenerate(
      makeCtx(),
      input({
        model: REFERENCE_CAPABLE,
        referenceRefs: Array.from({ length: 4 }, (_, i) => ({
          ref: `inline:style-${String(i)}`,
          role: 'style' as const,
        })),
      }),
      makeDeps(),
    );

    expect(result.status).toBe('FAILED');
    expect(generateImage).not.toHaveBeenCalled();
  });
});
