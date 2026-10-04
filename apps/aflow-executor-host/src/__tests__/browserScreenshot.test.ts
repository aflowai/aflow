/**
 * A screenshot is stored under its own payload kind, in the form a StepImage's
 * reference names, and the step returns it as a StepImage at the path its
 * operation declares: reference, type, size, dimensions and a line naming the
 * page. An image over the ceiling is retaken once as a JPEG, then refused with
 * both sizes.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import {
  BROWSER_SCREENSHOT_MAX_BYTES,
  findStepImages,
  getOperation,
  type PayloadKind,
  type PayloadRef,
  type SessionId,
  type StepExecutionId,
  StepImageSchema,
  type TenantId,
} from '@aflow/schemas';
import { describe, expect, it } from 'vitest';

import { screenshotDescription } from '../browser/screenshot.js';
import { createBrowserHandler } from '../handlers/browserHandler.js';
import { harness, RUN_A, type Harness } from './fixtures/fakeBrowser.js';
import { memoryApprovals } from './fixtures/approvals.js';

const PAGE = 'https://example.com/report';
const STEP = 'step-shot';

interface Written {
  readonly kind: string;
  readonly ref: PayloadRef;
  readonly data: unknown;
}

const payloads = createMemoryPayloadStore();

/** Writes through a real payload store, addressed by tenant, run, step and attempt as a job's are. */
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
    stepExecutionId: STEP,
    job: { inputRef: 'inline:input', stepExecutionId: STEP },
    readPayload: () => Promise.resolve(input),
    writePayload: async (kind: string, data: unknown) => {
      const ref = await payloads.store({
        tenantId: RUN_A.tenantId as TenantId,
        runId: RUN_A.runId as SessionId,
        stepExecutionId: STEP as StepExecutionId,
        attempt: 1,
        kind: kind as PayloadKind,
        data,
      });
      written.push({ kind, ref, data });
      return ref;
    },
  } as unknown as ExecutorContext;
  return { result: await createBrowserHandler(h.driver, memoryApprovals()).execute(ctx), written };
}

async function opened(sizes: { pngBytes?: number; jpegBytes?: number } = {}) {
  const h = harness({ world: { sites: new Map([[PAGE, { title: 'Report', ...sizes }]]) } });
  const { written } = await run(h, 'browser.page.open', { url: PAGE });
  return { h, pageId: (written.at(-1)?.data as { pageId: string }).pageId };
}

describe('browser.page.screenshot', () => {
  it('returns a StepImage at its declared path, naming the page, its bytes stored as { data, mimeType }', async () => {
    const { h, pageId } = await opened();
    const { result, written } = await run(h, 'browser.page.screenshot', { pageId });

    expect(result.status).toBe('SUCCEEDED');
    expect(written.map((entry) => entry.kind)).toEqual(['screenshot', 'output']);
    const [stored, output] = written;
    const operation = getOperation('browser.page.screenshot');
    expect(operation?.imageOutputPaths).toEqual(['image']);
    const parsed = operation?.outputZod?.parse(output?.data);
    expect(parsed).toEqual({
      pageId,
      url: PAGE,
      image: {
        ref: stored?.ref,
        contentType: 'image/png',
        sizeBytes: 64,
        width: 1280,
        height: 800,
        description: 'Screenshot of the visible window of "Report" at https://example.com/report',
      },
      receipt: { fullPage: false, retaken: false },
    });
    const image = StepImageSchema.parse((output?.data as { image: unknown }).image);
    expect(Object.keys(image).sort()).toEqual(
      ['contentType', 'description', 'height', 'ref', 'sizeBytes', 'width'].sort(),
    );

    const bytes = (await payloads.retrieve(image.ref)) as { data: string; mimeType: string };
    expect(bytes.mimeType).toBe('image/png');
    expect(Buffer.from(bytes.data, 'base64')).toHaveLength(image.sizeBytes);
    expect(JSON.stringify(output?.data)).not.toContain(bytes.data);

    // The agent turn carries it: the reference names a payload this step stored.
    const found = findStepImages(output?.data, operation!.imageOutputPaths!, {
      tenantId: RUN_A.tenantId,
      runId: RUN_A.runId,
      stepExecutionId: STEP,
    });
    expect(found).toEqual({ images: [image], withheld: [] });
  });

  it('describes what was captured of which page, on one line within the bound', () => {
    const page = { title: 'Quarterly\nreport', url: PAGE };
    expect(screenshotDescription(page, { fullPage: true })).toBe(
      'Screenshot of the whole page of "Quarterly report" at https://example.com/report',
    );
    expect(screenshotDescription(page, { ref: 'e6', fullPage: false })).toBe(
      'Screenshot of element `e6` of "Quarterly report" at https://example.com/report',
    );
    expect(screenshotDescription({ title: '', url: PAGE }, { fullPage: false })).toBe(
      'Screenshot of the visible window of https://example.com/report',
    );
    const long = screenshotDescription(
      { title: 'T'.repeat(500), url: `${PAGE}/${'p'.repeat(500)}` },
      { fullPage: false },
    );
    expect(StepImageSchema.shape.description.parse(long)).toBe(long);
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

    expect(written[0]?.data).toMatchObject({ mimeType: 'image/jpeg' });
    expect(written.at(-1)?.data).toMatchObject({
      image: { contentType: 'image/jpeg', sizeBytes: 900, width: 1280, height: 800 },
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
