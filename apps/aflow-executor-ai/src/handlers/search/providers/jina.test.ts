import { afterEach, describe, expect, it, vi } from 'vitest';
import { JinaFetchProvider, JinaFetchError } from './jina.js';
import { MAX_EXTRACTED_CONTENT_CHARS } from './types.js';

const request = {
  url: 'https://example.com/page',
  format: 'markdown' as const,
  maxContentLength: 50_000,
  includeImages: false,
  includeLinks: false,
  screenshot: false,
  timeoutMs: 30_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('JinaFetchProvider transport bound', () => {
  it('parses a normal response and truncates content to maxContentLength', async () => {
    const body = JSON.stringify({
      code: 200,
      data: { content: 'y'.repeat(60_000), url: 'https://example.com/page', title: 'Page' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

    const result = await new JinaFetchProvider().fetch(request);
    expect(result.content.length).toBe(50_000);
    expect(result.truncated).toBe(true);
    expect(result.title).toBe('Page');
  });

  it('aborts a response that exceeds the byte cap instead of buffering it', async () => {
    const capBytes = MAX_EXTRACTED_CONTENT_CHARS * 6 + 1024 * 1024;
    const chunk = new Uint8Array(4 * 1024 * 1024);
    const chunksNeeded = Math.ceil(capBytes / chunk.byteLength) + 1;
    let pushed = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pushed < chunksNeeded) {
          pushed += 1;
          controller.enqueue(chunk);
        } else {
          controller.close();
        }
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    const err = await new JinaFetchProvider()
      .fetch(request)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JinaFetchError);
    expect((err as Error).message).toMatch(/transport cap/);
    expect((err as JinaFetchError).retryable).toBe(false);
  });
});
