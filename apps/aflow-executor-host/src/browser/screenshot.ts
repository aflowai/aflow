/**
 * A screenshot within the size ceiling.
 *
 * Taken as a PNG, which is exact; one over the ceiling is taken once more as a
 * JPEG at lower quality, and one still over it is refused with both sizes, so
 * the caller can choose a smaller region rather than receive a truncated image
 * or none at all.
 */
import {
  BROWSER_SCREENSHOT_MAX_BYTES,
  BROWSER_SCREENSHOT_RETAKE_QUALITY,
  STEP_IMAGE_DESCRIPTION_MAX_CHARS,
} from '@aflow/schemas';

import { BrowserDriverError } from './errors.js';
import { imageSize } from './imageSize.js';
import type { EnginePage } from './types.js';

export interface ScreenshotRequest {
  readonly ref?: string;
  readonly fullPage: boolean;
}

export interface TakenScreenshot {
  readonly bytes: Buffer;
  readonly contentType: 'image/png' | 'image/jpeg';
  readonly width: number;
  readonly height: number;
  readonly retaken: boolean;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function captured(request: ScreenshotRequest): string {
  if (request.ref !== undefined) return `element \`${request.ref}\``;
  return request.fullPage ? 'the whole page' : 'the visible window';
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** The longest page title a description quotes, so the address still fits. */
const DESCRIPTION_TITLE_MAX_CHARS = 80;

/**
 * What a model that cannot see the image reads instead: what was captured, of
 * which page. The title is the page's own text, so it is cut to one line.
 */
export function screenshotDescription(
  page: { readonly title: string; readonly url: string },
  request: ScreenshotRequest,
): string {
  const title = oneLine(page.title, DESCRIPTION_TITLE_MAX_CHARS);
  const named = title === '' ? page.url : `"${title}" at ${page.url}`;
  return oneLine(
    `Screenshot of ${captured(request)} of ${named}`,
    STEP_IMAGE_DESCRIPTION_MAX_CHARS,
  );
}

export async function screenshotWithinCeiling(
  page: EnginePage,
  request: ScreenshotRequest,
  maxBytes: number = BROWSER_SCREENSHOT_MAX_BYTES,
): Promise<TakenScreenshot> {
  const png = await page.screenshot(request);
  if (png.length <= maxBytes) {
    return { bytes: png, contentType: 'image/png', ...imageSize(png, 'image/png'), retaken: false };
  }
  const jpeg = await page.screenshot({
    ...request,
    jpegQuality: BROWSER_SCREENSHOT_RETAKE_QUALITY,
  });
  if (jpeg.length <= maxBytes) {
    return {
      bytes: jpeg,
      contentType: 'image/jpeg',
      ...imageSize(jpeg, 'image/jpeg'),
      retaken: true,
    };
  }
  throw new BrowserDriverError(
    'screenshot_too_large',
    `A screenshot of ${captured(request)} is ${megabytes(png.length)} as a PNG and ${megabytes(jpeg.length)} ` +
      `as a JPEG at quality ${String(BROWSER_SCREENSHOT_RETAKE_QUALITY)}, over the ` +
      `${megabytes(maxBytes)} a screenshot may be; nothing was stored. ` +
      (request.fullPage
        ? 'Capture the visible window, or one element, instead.'
        : 'Capture one smaller element of the page instead.'),
    { pngBytes: String(png.length), jpegBytes: String(jpeg.length), maxBytes: String(maxBytes) },
  );
}
