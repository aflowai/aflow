import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StepImage } from '@aflow/schemas';
import { createAIClient } from './client.js';
import {
  MAX_TOOL_IMAGES_PER_TURN,
  MAX_TOOL_IMAGE_BYTES_PER_TURN,
  prepareToolImages,
} from './toolImages.js';
import type {
  ChatMessage,
  GenerateTextRequest,
  GenerateTextResponse,
  ToolImageResolver,
} from './types.js';

const seen: GenerateTextRequest[] = [];

vi.mock('./providers/anthropic.js', () => ({
  createAnthropicAdapter: () => ({
    provider: 'anthropic',
    generateText: (request: GenerateTextRequest): Promise<GenerateTextResponse> => {
      seen.push(request);
      return Promise.resolve({
        content: 'ok',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: 'stub',
      });
    },
  }),
}));

vi.mock('./providers/fireworks.js', () => ({
  createFireworksAdapter: () => ({
    provider: 'fireworks',
    generateText: (request: GenerateTextRequest): Promise<GenerateTextResponse> => {
      seen.push(request);
      return Promise.resolve({
        content: 'ok',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: 'stub',
      });
    },
  }),
}));

const VISION_MODEL = 'claude-sonnet-5';
const TEXT_ONLY_MODEL = 'accounts/fireworks/models/deepseek-v4-pro-0813';

function image(n: number, sizeBytes = 1000): StepImage {
  return {
    ref: `inline:${Buffer.from(JSON.stringify({ n })).toString('base64')}`,
    contentType: 'image/png',
    sizeBytes,
    width: 1280,
    height: 720,
    description: `Screenshot ${String(n)}`,
  };
}

function toolMessage(id: string, images: StepImage[]): ChatMessage {
  return {
    role: 'tool',
    toolCallId: id,
    name: 'browser_screenshot',
    content: [
      { type: 'text', text: `{"kind":"tool_result","toolCallId":"${id}"}` },
      ...images.map((img) => ({ type: 'image_ref' as const, image: img })),
    ],
  };
}

function assistantCalling(...ids: string[]): ChatMessage {
  return {
    role: 'assistant',
    content: null,
    toolCalls: ids.map((id) => ({
      id,
      type: 'function' as const,
      function: { name: 'browser_screenshot', arguments: '{}' },
    })),
  };
}

function bytesOf(sizeBytes: number): string {
  return Buffer.alloc(sizeBytes, 1).toString('base64');
}

function resolverReturningDeclaredSize(): ToolImageResolver & { calls: StepImage[] } {
  const calls: StepImage[] = [];
  const resolve = (img: StepImage) => {
    calls.push(img);
    return Promise.resolve({
      ok: true as const,
      data: bytesOf(img.sizeBytes),
      mediaType: 'image/png',
    });
  };
  return Object.assign(resolve, { calls });
}

function partsOf(message: ChatMessage | undefined) {
  if (message?.role !== 'tool' || typeof message.content === 'string') {
    throw new Error('expected a tool message with parts');
  }
  return message.content;
}

function shownImages(messages: ChatMessage[]): number {
  return messages
    .flatMap((m) => (m.role === 'tool' && typeof m.content !== 'string' ? m.content : []))
    .filter((p) => p.type === 'image').length;
}

function reducedTexts(messages: ChatMessage[]): string[] {
  return messages
    .flatMap((m) => (m.role === 'tool' && typeof m.content !== 'string' ? m.content : []))
    .flatMap((p) => (p.type === 'text' && p.text.startsWith('[Image not shown') ? [p.text] : []));
}

describe('prepareToolImages', () => {
  it('returns the same messages when no tool message carries an image', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      assistantCalling('c1'),
      { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
    ];
    const out = await prepareToolImages(messages, {
      vision: true,
      resolve: undefined,
      provider: 'anthropic',
    });
    expect(out).toBe(messages);
  });

  it('shows the image to a vision model, read through the resolver', async () => {
    const resolve = resolverReturningDeclaredSize();
    const out = await prepareToolImages([assistantCalling('c1'), toolMessage('c1', [image(1)])], {
      vision: true,
      resolve,
      provider: 'anthropic',
    });
    expect(resolve.calls).toHaveLength(1);
    const parts = partsOf(out[1]);
    expect(parts.map((p) => p.type)).toEqual(['text', 'text', 'image']);
    expect(parts[1]).toEqual({ type: 'text', text: 'Image 1280×720 image/png: Screenshot 1' });
    expect(parts[2]).toEqual({
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data: bytesOf(1000) },
    });
  });

  it('gives a model without vision the description and size, and reads nothing', async () => {
    const resolve = resolverReturningDeclaredSize();
    const out = await prepareToolImages([assistantCalling('c1'), toolMessage('c1', [image(1)])], {
      vision: false,
      resolve,
      provider: 'fireworks',
    });
    expect(resolve.calls).toHaveLength(0);
    expect(partsOf(out[1])[1]).toEqual({
      type: 'text',
      text: '[Image not shown — this model does not take images. 1280×720 image/png: Screenshot 1]',
    });
  });

  it('shows images only from the most recent tool results', async () => {
    const resolve = resolverReturningDeclaredSize();
    const out = await prepareToolImages(
      [
        assistantCalling('c1'),
        toolMessage('c1', [image(1)]),
        assistantCalling('c2', 'c3'),
        toolMessage('c2', [image(2)]),
        toolMessage('c3', [image(3)]),
      ],
      { vision: true, resolve, provider: 'anthropic' },
    );
    expect(resolve.calls.map((c) => c.description)).toEqual(['Screenshot 3', 'Screenshot 2']);
    expect(partsOf(out[1])[1]).toEqual({
      type: 'text',
      text:
        '[Image not shown — images are shown only from the most recent tool results. ' +
        '1280×720 image/png: Screenshot 1]',
    });
    expect(shownImages(out)).toBe(2);
  });

  it('sends the newest images up to the per-turn count and reduces the older ones', async () => {
    const resolve = resolverReturningDeclaredSize();
    const count = MAX_TOOL_IMAGES_PER_TURN + 2;
    const images = Array.from({ length: count }, (_, i) => image(i + 1));
    const out = await prepareToolImages([assistantCalling('c1'), toolMessage('c1', images)], {
      vision: true,
      resolve,
      provider: 'anthropic',
    });
    expect(shownImages(out)).toBe(MAX_TOOL_IMAGES_PER_TURN);
    const reduced = reducedTexts(out);
    expect(reduced).toHaveLength(2);
    expect(reduced[0]).toContain('Screenshot 1]');
    expect(reduced[1]).toContain('Screenshot 2]');
    expect(reduced[0]).toContain("this turn's image limit");
    expect(resolve.calls).toHaveLength(MAX_TOOL_IMAGES_PER_TURN);
  });

  it('holds the per-turn byte ceiling, newest first', async () => {
    const resolve = resolverReturningDeclaredSize();
    const big = Math.floor(MAX_TOOL_IMAGE_BYTES_PER_TURN / 2) + 1;
    const out = await prepareToolImages(
      [assistantCalling('c1'), toolMessage('c1', [image(1, big), image(2, big)])],
      { vision: true, resolve, provider: 'anthropic' },
    );
    expect(resolve.calls.map((c) => c.description)).toEqual(['Screenshot 2']);
    expect(shownImages(out)).toBe(1);
    expect(reducedTexts(out)).toEqual([
      expect.stringContaining('went to newer images. 1280×720 image/png: Screenshot 1]'),
    ]);
  });

  it('holds the byte ceiling to the bytes actually read', async () => {
    const under: ToolImageResolver = () =>
      Promise.resolve({
        ok: true,
        data: bytesOf(MAX_TOOL_IMAGE_BYTES_PER_TURN + 1),
        mediaType: 'image/png',
      });
    const out = await prepareToolImages([assistantCalling('c1'), toolMessage('c1', [image(1)])], {
      vision: true,
      resolve: under,
      provider: 'anthropic',
    });
    expect(shownImages(out)).toBe(0);
    expect(reducedTexts(out)[0]).toContain("this turn's image limit");
  });

  it('names an image whose bytes could not be read', async () => {
    const out = await prepareToolImages([assistantCalling('c1'), toolMessage('c1', [image(1)])], {
      vision: true,
      resolve: () => Promise.resolve({ ok: false, reason: 'payload not found' }),
      provider: 'anthropic',
    });
    expect(reducedTexts(out)[0]).toBe(
      '[Image not shown — its bytes could not be read: payload not found. 1280×720 image/png: Screenshot 1]',
    );
  });

  it('refuses a vision request that carries an image and no way to read it', async () => {
    await expect(
      prepareToolImages([assistantCalling('c1'), toolMessage('c1', [image(1)])], {
        vision: true,
        resolve: undefined,
        provider: 'anthropic',
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('tool images at the request choke point', () => {
  beforeEach(() => {
    seen.length = 0;
  });

  function client() {
    return createAIClient({
      providers: { anthropic: {}, fireworks: {} },
    });
  }

  it('reads the catalog: the vision flags these cases rely on', () => {
    expect(client().getModel(VISION_MODEL)?.capabilities.vision).toBe(true);
    expect(client().getModel(TEXT_ONLY_MODEL)?.capabilities.vision).toBe(false);
  });

  it("hands a vision model's adapter the image and never the resolver", async () => {
    const resolve = resolverReturningDeclaredSize();
    await client().generateText({
      model: VISION_MODEL,
      messages: [assistantCalling('c1'), toolMessage('c1', [image(1)])],
      resolveToolImage: resolve,
    } as GenerateTextRequest);
    const request = seen.at(-1)!;
    expect(resolve.calls).toHaveLength(1);
    expect(shownImages(request.messages)).toBe(1);
    expect('resolveToolImage' in request).toBe(false);
  });

  it('gives a model without vision text, and never calls the resolver', async () => {
    const resolve = vi.fn<ToolImageResolver>();
    await client().generateText({
      model: TEXT_ONLY_MODEL,
      messages: [assistantCalling('c1'), toolMessage('c1', [image(1)])],
      resolveToolImage: resolve,
    } as GenerateTextRequest);
    expect(resolve).not.toHaveBeenCalled();
    const parts = partsOf(seen.at(-1)!.messages[1]);
    expect(parts.some((p) => p.type === 'image' || p.type === 'image_ref')).toBe(false);
    expect(parts[1]).toEqual({
      type: 'text',
      text: '[Image not shown — this model does not take images. 1280×720 image/png: Screenshot 1]',
    });
  });
});
