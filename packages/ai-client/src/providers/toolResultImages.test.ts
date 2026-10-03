/**
 * What each adapter puts on the wire for a tool result that carries an image.
 * The client has already resolved the reference, so an adapter sees `text`
 * and `image` parts only. Anthropic keeps the image inside the tool result;
 * every other adapter sends the result as text and the image in a user
 * message after the tool results.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId, StepExecutionId, TenantId } from '@aflow/schemas';
import type { ChatMessage, GenerateTextRequest } from '../types.js';
import { toAnthropicMessages } from './anthropic.js';
import { toGeminiContents } from './google.js';
import { createOpenAIAdapter } from './openai.js';
import { createOpenRouterAdapter } from './openrouter.js';
import { createFireworksAdapter } from './fireworks.js';
import { createXaiAdapter } from './xai.js';
import { moveToolImagesToUserMessages } from './toolResultContent.js';

const PIXELS = 'iVBORw0KGgo=';
const PLACEHOLDER = '[The image is in the user message that follows the tool results.]';

const context = {
  tenantId: 'tenant' as TenantId,
  runId: 'run' as SessionId,
  stepExecutionId: 'step' as StepExecutionId,
};

function conversation(): ChatMessage[] {
  return [
    { role: 'user', content: 'Open the page and look at it.' },
    {
      role: 'assistant',
      content: null,
      toolCalls: [
        { id: 'c_0', type: 'function', function: { name: 'screenshot', arguments: '{}' } },
        { id: 'c_1', type: 'function', function: { name: 'read', arguments: '{}' } },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'c_0',
      name: 'screenshot',
      content: [
        { type: 'text', text: '{"status":"SUCCEEDED"}' },
        { type: 'text', text: 'Image 1280×720 image/png: The sign-in page' },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: PIXELS } },
      ],
    },
    { role: 'tool', toolCallId: 'c_1', name: 'read', content: 'page text' },
  ];
}

const screenshotText = `{"status":"SUCCEEDED"}\nImage 1280×720 image/png: The sign-in page\n${PLACEHOLDER}`;

describe('Anthropic — image blocks inside the tool_result', () => {
  it('renders the tool result as text and image blocks', () => {
    const { messages } = toAnthropicMessages(conversation());
    const results = messages.at(-1)!;
    expect(results.role).toBe('user');
    expect(results.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'c_0',
        content: [
          { type: 'text', text: '{"status":"SUCCEEDED"}' },
          { type: 'text', text: 'Image 1280×720 image/png: The sign-in page' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXELS } },
        ],
      },
      { type: 'tool_result', tool_use_id: 'c_1', content: 'page text' },
    ]);
  });
});

describe('text-then-user-image form', () => {
  it('leaves a conversation with no tool image as the same array', () => {
    const messages: ChatMessage[] = [{ role: 'tool', toolCallId: 'c_0', content: 'r' }];
    expect(moveToolImagesToUserMessages(messages, 'openai')).toBe(messages);
  });

  it('puts the user message after the whole run of tool results', () => {
    const out = moveToolImagesToUserMessages(conversation(), 'openai');
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user']);
    expect(out[2]).toMatchObject({ role: 'tool', content: screenshotText });
    expect(out[4]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Output of tool call c_0 (screenshot):' },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: PIXELS } },
      ],
    });
  });
});

describe('Google — functionResponse text, then a user turn with the image', () => {
  it('renders the tool result as text and the image as inlineData after it', () => {
    const { contents } = toGeminiContents(conversation(), { nativeFunctionCalling: true });
    const responses = contents[2]!;
    expect(responses.parts?.map((p) => p.functionResponse?.response)).toEqual([
      { result: screenshotText },
      { result: 'page text' },
    ]);
    // The adapter's existing role-alternation bridge separates the function
    // responses from the user turn that carries the image.
    expect(contents[3]).toEqual({ role: 'model', parts: [{ text: '[Processed tool results]' }] });
    expect(contents[4]).toEqual({
      role: 'user',
      parts: [
        { text: 'Output of tool call c_0 (screenshot):' },
        { inlineData: { mimeType: 'image/png', data: PIXELS } },
      ],
    });
  });
});

describe('OpenAI-SDK adapters — wire body', () => {
  let bodies: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    bodies = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: { body?: string }) => {
        bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'captured' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The SDK refuses to construct without a key; the stubbed fetch never sends it.
  const offline = { apiKey: randomUUID(), baseUrl: 'http://wire.invalid/v1', maxRetries: 0 };

  const request: GenerateTextRequest = { model: 'm', messages: conversation(), ...context };

  const chatCompletionsTail = [
    { role: 'tool', tool_call_id: 'c_0', content: screenshotText },
    { role: 'tool', tool_call_id: 'c_1', content: 'page text' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Output of tool call c_0 (screenshot):' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PIXELS}` } },
      ],
    },
  ];

  const responsesTail = [
    { type: 'function_call_output', call_id: 'c_0', output: screenshotText },
    { type: 'function_call_output', call_id: 'c_1', output: 'page text' },
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Output of tool call c_0 (screenshot):' },
        {
          type: 'input_image',
          image_url: `data:image/png;base64,${PIXELS}`,
          detail: 'auto',
        },
      ],
    },
  ];

  it('OpenAI Responses: function_call_output text, then a user message with input_image', async () => {
    await expect(createOpenAIAdapter(offline).generateText(request)).rejects.toThrow();
    expect((bodies[0]!['input'] as unknown[]).slice(-3)).toEqual(responsesTail);
  });

  it('OpenAI chat completions (generateJson): tool text, then a user message with image_url', async () => {
    await expect(
      createOpenAIAdapter(offline).generateJson({
        ...request,
        schema: { parse: (v: unknown) => v } as never,
        rawJsonSchema: { type: 'object' },
        strictJsonSchema: false,
      }),
    ).rejects.toThrow();
    expect((bodies[0]!['messages'] as unknown[]).slice(-3)).toEqual(chatCompletionsTail);
  });

  it('xAI (OpenAI Responses underneath): the same form', async () => {
    await expect(createXaiAdapter(offline).generateText(request)).rejects.toThrow();
    expect((bodies[0]!['input'] as unknown[]).slice(-3)).toEqual(responsesTail);
  });

  it('OpenRouter: tool text, then a user message with image_url', async () => {
    await expect(createOpenRouterAdapter(offline).generateText(request)).rejects.toThrow();
    expect((bodies[0]!['messages'] as unknown[]).slice(-3)).toEqual(chatCompletionsTail);
  });

  it('Fireworks: tool text, then a user message with image_url', async () => {
    await expect(createFireworksAdapter(offline).generateText(request)).rejects.toThrow();
    expect((bodies[0]!['messages'] as unknown[]).slice(-3)).toEqual(chatCompletionsTail);
  });
});
