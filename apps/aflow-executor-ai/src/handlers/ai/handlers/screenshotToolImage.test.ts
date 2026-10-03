/**
 * A screenshot step's image on the next agent turn (Plan 320 D10): the
 * declared image is read from the step's output, carried on its tool result,
 * converted for the request, and at the client's choke point either read from
 * the payload store and shown to a model with vision, or reduced to its
 * description for one without. Everything but the provider is the real code;
 * the stored form and the image are what `browser.page.screenshot` writes
 * (`apps/aflow-executor-host/src/__tests__/browserScreenshot.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAIClient,
  type ChatMessage,
  type GenerateTextRequest,
  type GenerateTextResponse,
} from '@aflow/ai-client';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import {
  type AiToolResultEnvelopeV1,
  BrowserPageScreenshotOutputSchema,
  findStepImages,
  getOperation,
  type SessionId,
  type StepExecutionId,
  type TenantId,
  toolResultMessage,
} from '@aflow/schemas';
import { aiMessageToChatMessage } from './agentMessageConversion.js';
import { toolImageResolver } from './mediaSourceRef.js';

const seen: GenerateTextRequest[] = [];

function recordingAdapter(provider: 'anthropic' | 'fireworks') {
  return {
    provider,
    generateText: (request: GenerateTextRequest): Promise<GenerateTextResponse> => {
      seen.push(request);
      return Promise.resolve({
        content: 'ok',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: 'stub',
        provider,
      });
    },
  };
}

vi.mock('../../../../../../packages/ai-client/src/providers/anthropic.js', () => ({
  createAnthropicAdapter: () => recordingAdapter('anthropic'),
}));
vi.mock('../../../../../../packages/ai-client/src/providers/fireworks.js', () => ({
  createFireworksAdapter: () => recordingAdapter('fireworks'),
}));

const VISION_MODEL = 'claude-sonnet-5';
const TEXT_ONLY_MODEL = 'accounts/fireworks/models/deepseek-v4-pro-0813';

const TENANT = 'tenant-1';
const RUN = 'run-1';
const SCREENSHOT_STEP = 'step-shot';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR-and-the-rest-of-a-page'),
]);
const DESCRIPTION = 'Screenshot of the visible window of "Report" at https://example.com/report';

async function screenshotStep() {
  const payloads = createMemoryPayloadStore();
  const ref = await payloads.store({
    tenantId: TENANT as TenantId,
    runId: RUN as SessionId,
    stepExecutionId: SCREENSHOT_STEP as StepExecutionId,
    attempt: 1,
    kind: 'screenshot',
    data: { data: PNG.toString('base64'), mimeType: 'image/png' },
  });
  const output = BrowserPageScreenshotOutputSchema.parse({
    pageId: 'pg_1',
    url: 'https://example.com/report',
    image: {
      ref,
      contentType: 'image/png',
      sizeBytes: PNG.length,
      width: 1280,
      height: 800,
      description: DESCRIPTION,
    },
    receipt: { fullPage: false, retaken: false },
  });
  return { payloads, ref, output };
}

/** The next turn's messages: the call, and its result carrying what the step declared. */
async function nextTurn() {
  const step = await screenshotStep();
  const declared = getOperation('browser.page.screenshot')?.imageOutputPaths;
  if (declared === undefined) throw new Error('browser.page.screenshot declares no image');
  const { images, withheld } = findStepImages(step.output, declared, {
    tenantId: TENANT,
    runId: RUN,
    stepExecutionId: SCREENSHOT_STEP,
  });
  expect(withheld).toEqual([]);
  const envelope: AiToolResultEnvelopeV1 = {
    kind: 'tool_result',
    toolCallId: 'c1',
    toolName: 'browser.page.screenshot',
    status: 'SUCCEEDED',
    completedAtMs: 1,
    summary: 'Captured the page',
    images,
  };
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      toolCalls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'browser_page_screenshot', arguments: '{}' },
        },
      ],
    },
    aiMessageToChatMessage(toolResultMessage(envelope)),
  ];
  const ctx = {
    job: { tenantId: TENANT, stepExecutionId: 'step-turn-2' },
    runId: RUN,
    readPayload: (ref: string) => step.payloads.retrieve(ref as never),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as ExecutorContext;
  return { messages, ctx, ref: step.ref };
}

function toolParts(request: GenerateTextRequest) {
  const tool = request.messages.find((message) => message.role === 'tool');
  if (tool === undefined || typeof tool.content === 'string') {
    throw new Error('expected the tool result with parts');
  }
  return tool.content;
}

describe('a screenshot on the next agent turn', () => {
  beforeEach(() => {
    seen.length = 0;
  });

  it('reaches a model with vision as an image part holding the stored bytes', async () => {
    const { messages, ctx, ref } = await nextTurn();
    await createAIClient({ providers: { anthropic: {} } }).generateText({
      model: VISION_MODEL,
      messages,
      resolveToolImage: toolImageResolver(ctx),
    } as GenerateTextRequest);

    const parts = toolParts(seen.at(-1)!);
    expect(parts.filter((part) => part.type === 'image')).toEqual([
      {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: PNG.toString('base64') },
      },
    ]);
    expect(parts).toContainEqual({
      type: 'text',
      text: `Image 1280×800 image/png: ${DESCRIPTION}`,
    });
    expect(JSON.stringify(seen.at(-1)!.messages)).not.toContain(ref);
  });

  it('reaches a model without vision as its description and size, reading nothing', async () => {
    const { messages, ctx, ref } = await nextTurn();
    const readPayload = vi.spyOn(ctx, 'readPayload');
    await createAIClient({ providers: { fireworks: {} } }).generateText({
      model: TEXT_ONLY_MODEL,
      messages,
      resolveToolImage: toolImageResolver(ctx),
    } as GenerateTextRequest);

    const parts = toolParts(seen.at(-1)!);
    expect(parts.some((part) => part.type === 'image' || part.type === 'image_ref')).toBe(false);
    expect(parts).toContainEqual({
      type: 'text',
      text: `[Image not shown — this model does not take images. 1280×800 image/png: ${DESCRIPTION}]`,
    });
    expect(readPayload).not.toHaveBeenCalled();
    expect(JSON.stringify(seen.at(-1)!.messages)).not.toContain(ref);
  });
});
