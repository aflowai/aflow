/**
 * A screenshot step's image on the next agent turn (Plan 320 D10): the
 * declared image is read from the step's output, carried on its tool result,
 * converted for the request, and at the client's choke point either read from
 * the payload store and shown to a model with vision, or reduced to its
 * description for one without. Everything up to the provider's SDK is the real
 * code, the adapters included; the stored form and the image are what
 * `browser.page.screenshot` writes
 * (`apps/aflow-executor-host/src/__tests__/browserScreenshot.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAIClient,
  type ChatMessage,
  type GenerateTextRequest,
  type ToolImageResolver,
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

// The SDKs, not the adapters' files: `@aflow/ai-client` resolves to its source
// or to its bundle depending on how the runner is configured, and a path into
// `src/providers` matches only the first, which sent these requests to the
// real providers.
const { sent } = vi.hoisted(() => ({ sent: [] as Array<Record<string, unknown>> }));

vi.mock('@anthropic-ai/sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  default: class {
    messages = {
      create: (params: Record<string, unknown>) => {
        sent.push(params);
        return Promise.resolve({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
          model: 'stub',
        });
      },
    };
  },
}));

vi.mock('openai', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  default: class {
    chat = {
      completions: {
        create: (params: Record<string, unknown>) => {
          sent.push(params);
          return Promise.resolve({
            choices: [
              { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            model: 'stub',
          });
        },
      },
    };
  },
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

interface WireBlock {
  type: string;
  tool_use_id?: string;
  content?: unknown;
}

/** The content of the Anthropic `tool_result` block answering call `c1`. */
function anthropicToolResult(params: Record<string, unknown>): unknown[] {
  const messages = params['messages'] as Array<{ role: string; content: unknown }>;
  const block = messages
    .flatMap((message) => (Array.isArray(message.content) ? (message.content as WireBlock[]) : []))
    .find((candidate) => candidate.type === 'tool_result' && candidate.tool_use_id === 'c1');
  if (!Array.isArray(block?.content)) throw new Error('expected the tool result with parts');
  return block.content as unknown[];
}

function turnRequest(
  model: string,
  messages: ChatMessage[],
  resolveToolImage: ToolImageResolver,
): GenerateTextRequest {
  return {
    model,
    messages,
    resolveToolImage,
    tenantId: TENANT as TenantId,
    runId: RUN as SessionId,
    stepExecutionId: 'step-turn-2' as StepExecutionId,
  };
}

describe('a screenshot on the next agent turn', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('reaches a model with vision as an image block holding the stored bytes', async () => {
    const { messages, ctx, ref } = await nextTurn();
    const resolveToolImage = vi.fn<ToolImageResolver>(toolImageResolver(ctx));
    await createAIClient({ providers: { anthropic: {} } }).generateText(
      turnRequest(VISION_MODEL, messages, resolveToolImage),
    );

    expect(resolveToolImage).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    const content = anthropicToolResult(sent[0]!);
    expect(content).toContainEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') },
    });
    expect(content).toContainEqual({
      type: 'text',
      text: `Image 1280×800 image/png: ${DESCRIPTION}`,
    });
    expect(JSON.stringify(sent[0])).not.toContain(ref);
  });

  it('reaches a model without vision as its description and size, reading nothing', async () => {
    const { messages, ctx, ref } = await nextTurn();
    const readPayload = vi.spyOn(ctx, 'readPayload');
    const resolveToolImage = vi.fn<ToolImageResolver>(toolImageResolver(ctx));
    await createAIClient({ providers: { fireworks: {} } }).generateText(
      turnRequest(TEXT_ONLY_MODEL, messages, resolveToolImage),
    );

    expect(sent).toHaveLength(1);
    const wire = JSON.stringify(sent[0]);
    const tool = (sent[0]!['messages'] as Array<{ role: string; content: unknown }>).find(
      (message) => message.role === 'tool',
    );
    expect(tool?.content).toContain(
      `[Image not shown — this model does not take images. 1280×800 image/png: ${DESCRIPTION}]`,
    );
    expect(wire).not.toContain('image_url');
    expect(wire).not.toContain(PNG.toString('base64'));
    expect(resolveToolImage).not.toHaveBeenCalled();
    expect(readPayload).not.toHaveBeenCalled();
    expect(wire).not.toContain(ref);
  });
});
