import { describe, expect, it } from 'vitest';
import {
  NEUTRALIZED_CONTENT_TYPE,
  isInlineSafeContentType,
  resolveServableHeaders,
} from './servableContentType.js';

/**
 * A stored media type is an instruction to the browser, and it is written by
 * whoever wrote the content. These cases are the ones where echoing it back
 * would turn stored bytes into script on an aflow.ai origin — the render
 * boundary never sees a response the browser fetched directly.
 */
describe('resolveServableHeaders', () => {
  const SCRIPT_CAPABLE = [
    'text/html',
    'image/svg+xml',
    'application/xhtml+xml',
    'text/xml',
    'application/xml',
    'text/xsl',
    'application/javascript',
    'text/javascript',
  ];

  it.each(SCRIPT_CAPABLE)('refuses to serve %s under its own label', (type) => {
    const headers = resolveServableHeaders(type);
    expect(headers.contentType).toBe(NEUTRALIZED_CONTENT_TYPE);
    expect(headers.contentDisposition).toBe('attachment');
    expect(isInlineSafeContentType(type)).toBe(false);
  });

  it('does not let a parameter smuggle a refused type past the check', () => {
    // A set membership test on the raw value would miss this one.
    expect(resolveServableHeaders('text/html; charset=utf-8').contentType).toBe(
      NEUTRALIZED_CONTENT_TYPE,
    );
    expect(resolveServableHeaders('IMAGE/SVG+XML').contentType).toBe(NEUTRALIZED_CONTENT_TYPE);
    expect(resolveServableHeaders('  text/html  ').contentType).toBe(NEUTRALIZED_CONTENT_TYPE);
  });

  // Media is decoded by a pipeline with no script context, and a player needs
  // the label. Withholding it was an over-reach that broke a shipped reader.
  it.each([
    'application/json',
    'text/plain',
    'text/markdown',
    'image/png',
    'application/pdf',
    'video/mp4',
    'video/webm',
    'audio/mpeg',
  ])('still serves %s inline, so the fix does not break reading documents', (type) => {
    const headers = resolveServableHeaders(type);
    expect(headers.contentType).toBe(type);
    expect(headers.contentDisposition).toBeUndefined();
  });

  it('never echoes an unrecognised type back, even a harmless-looking one', () => {
    // The returned value is always one of the two known-safe forms — a
    // reconstructed variant of caller input is what this avoids.
    expect(resolveServableHeaders('application/vnd.made-up').contentType).toBe(
      NEUTRALIZED_CONTENT_TYPE,
    );
    expect(resolveServableHeaders('').contentType).toBe(NEUTRALIZED_CONTENT_TYPE);
    expect(resolveServableHeaders(null).contentType).toBe(NEUTRALIZED_CONTENT_TYPE);
    expect(resolveServableHeaders(undefined).contentType).toBe(NEUTRALIZED_CONTENT_TYPE);
  });
});
