/**
 * A screenshot is stored under its own payload kind, as bytes, and the step
 * returns only its reference and what it is: type, size and dimensions. An
 * image over the ceiling is retaken once as a JPEG, then refused with both
 * sizes.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { BROWSER_SCREENSHOT_MAX_BYTES, getOperation } from '@aflow/schemas';
import { describe, expect, it } from 'vitest';

import { createBrowserHandler } from '../handlers/browserHandler.js';
import { harness, RUN_A, type Harness } from './fixtures/fakeBrowser.js';

const PAGE = 'https://example.com/report';

interface Written {
  readonly kind: string;
  readonly data: unknown;
  readonly contentType?: string;
}

async function run(
  h: Harness,
  operationId: string,
  input: unknown,
): Promise<{ result: StepResult; written: Written[] }> {
  const written: Written[] = [];
  const ctx = {
    tenantId: RUN_A.tenantId,
    runId: RUN_A.runId,
    spaceId: RUN_A.spaceId,
    attempt: 1,
    operationId,
    job: { inputRef: 'inline:input' },
    readPayload: () => Promise.resolve(input),
    writePayload: (kind: string, data: unknown, options?: { contentType?: string }) => {
      written.push({
        kind,
        data,
        ...(options?.contentType !== undefined ? { contentType: options.contentType } : {}),
      });
      return Promise.resolve(`gs://payloads/${kind}.${String(written.length)}`);
    },
  } as unknown as ExecutorContext;
  return { result: await createBrowserHandler(h.driver).execute(ctx), written };
}

async function opened(sizes: { pngBytes?: number; jpegBytes?: number } = {}) {
  const h = harness({ world: { sites: new Map([[PAGE, { title: 'Report', ...sizes }]]) } });
  const { written } = await run(h, 'browser.page.open', { url: PAGE });
  return { h, pageId: (written.at(-1)?.data as { pageId: string }).pageId };
}

describe('browser.page.screenshot', () => {
  it('stores the image as bytes under the screenshot kind and returns a reference with its metadata', async () => {
    const { h, pageId } = await opened();
    const { result, written } = await run(h, 'browser.page.screenshot', { pageId });

    expect(result.status).toBe('SUCCEEDED');
    expect(written.map((entry) => entry.kind)).toEqual(['screenshot', 'output']);
    const [image, output] = written;
    expect(Buffer.isBuffer(image?.data)).toBe(true);
    expect(image?.contentType).toBe('image/png');
    const parsed = getOperation('browser.page.screenshot')?.outputZod?.parse(output?.data);
    expect(parsed).toEqual({
      pageId,
      url: PAGE,
      contentRef: 'gs://payloads/screenshot.1',
      contentType: 'image/png',
      bytes: 64,
      width: 1280,
      height: 800,
      receipt: { fullPage: false, retaken: false },
    });
    expect(JSON.stringify(output?.data)).not.toContain('base64');
  });

  it('captures one element or the whole page as asked', async () => {
    const { h, pageId } = await opened();
    await run(h, 'browser.page.screenshot', { pageId, ref: 'e6' });
    await run(h, 'browser.page.screenshot', { pageId, fullPage: true });
    expect(h.pages[0]?.screenshots).toEqual([{ ref: 'e6', fullPage: false }, { fullPage: true }]);
    const stale = await run(h, 'browser.page.screenshot', { pageId, ref: 'e404' });
    expect(stale.written.at(-1)?.data).toMatchObject({ code: 'BROWSER_REF_STALE' });
  });

  it('retakes an image over the ceiling once as a JPEG', async () => {
    const { h, pageId } = await opened({
      pngBytes: BROWSER_SCREENSHOT_MAX_BYTES + 1,
      jpegBytes: 900,
    });
    const { written } = await run(h, 'browser.page.screenshot', { pageId });

    expect(written[0]?.contentType).toBe('image/jpeg');
    expect(written.at(-1)?.data).toMatchObject({
      contentType: 'image/jpeg',
      bytes: 900,
      width: 1280,
      height: 800,
      receipt: { retaken: true },
    });
    expect(h.pages[0]?.screenshots.map((shot) => shot.jpegQuality)).toEqual([undefined, 60]);
  });

  it('refuses an image still over the ceiling, with the numbers, storing nothing', async () => {
    const tooBig = BROWSER_SCREENSHOT_MAX_BYTES + 1;
    const { h, pageId } = await opened({ pngBytes: tooBig, jpegBytes: tooBig });
    const { result, written } = await run(h, 'browser.page.screenshot', { pageId, fullPage: true });

    expect(result.status).toBe('FAILED');
    expect(written.map((entry) => entry.kind)).toEqual(['error']);
    expect(written[0]?.data).toMatchObject({
      code: 'BROWSER_SCREENSHOT_TOO_LARGE',
      retryable: false,
      details: {
        pngBytes: String(tooBig),
        jpegBytes: String(tooBig),
        maxBytes: String(BROWSER_SCREENSHOT_MAX_BYTES),
      },
    });
    expect((written[0]?.data as { message: string }).message).toContain(
      'Capture the visible window, or one element, instead.',
    );
  });
});
