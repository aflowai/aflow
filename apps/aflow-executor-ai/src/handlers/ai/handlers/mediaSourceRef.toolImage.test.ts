/**
 * A tool image goes to the provider only when its bytes, its payload and its
 * declaration agree on what it is. Anything else becomes its description, so a
 * bad image costs the model the picture and never fails the turn.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { StepImage, StepImageContentType } from '@aflow/schemas';
import { toolImageResolver } from './mediaSourceRef.js';
import { imageContentTypeFromSignature } from './mediaProbe.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR-and-the-rest'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-body')]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 body'),
]);
const GIF = Buffer.from('GIF89a-and-the-rest');
const TEXT = Buffer.from('<!doctype html><html></html>');

const REF = 'gs://aflow-payloads/tenants/tenant-1/runs/run-1/steps/exec-1/attempt/1/body.json';

function stepImage(contentType: StepImageContentType): StepImage {
  return { ref: REF, contentType, sizeBytes: 64, width: 1280, height: 720 };
}

function ctxReading(payload: unknown) {
  const warn = vi.fn();
  const ctx = {
    job: { tenantId: 'tenant-1', stepExecutionId: 'exec-2' },
    runId: 'run-1',
    readPayload: async () => payload,
    log: { info: () => {}, warn, error: () => {}, debug: () => {} },
  } as unknown as ExecutorContext;
  return { ctx, warn };
}

async function resolveWith(
  bytes: Buffer,
  payloadMimeType: string | undefined,
  declared: StepImageContentType,
) {
  const { ctx, warn } = ctxReading({
    data: bytes.toString('base64'),
    ...(payloadMimeType !== undefined ? { mimeType: payloadMimeType } : {}),
  });
  return { resolution: await toolImageResolver(ctx)(stepImage(declared)), warn };
}

describe('imageContentTypeFromSignature', () => {
  it.each([
    [PNG, 'image/png'],
    [JPEG, 'image/jpeg'],
    [WEBP, 'image/webp'],
  ])('recognises %#', (bytes, expected) => {
    expect(imageContentTypeFromSignature(bytes)).toBe(expected);
  });

  it.each([
    ['gif', GIF],
    ['text', TEXT],
    ['nothing', Buffer.alloc(0)],
    ['a RIFF that is not WEBP', Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt ')],
    ['a cut-off png signature', PNG.subarray(0, 5)],
  ])('recognises nothing in %s', (_label, bytes) => {
    expect(imageContentTypeFromSignature(bytes)).toBeUndefined();
  });
});

describe('toolImageResolver', () => {
  it.each([
    ['png', PNG, 'image/png'],
    ['jpeg', JPEG, 'image/jpeg'],
    ['webp', WEBP, 'image/webp'],
  ] as const)('shows %s when bytes, payload and declaration agree', async (_l, bytes, type) => {
    const { resolution, warn } = await resolveWith(bytes, type, type);
    expect(resolution).toEqual({ ok: true, data: bytes.toString('base64'), mediaType: type });
    expect(warn).not.toHaveBeenCalled();
  });

  it('shows an image whose payload states no mimeType, sent as the type both others name', async () => {
    const { resolution } = await resolveWith(JPEG, undefined, 'image/jpeg');
    expect(resolution).toEqual({
      ok: true,
      data: JPEG.toString('base64'),
      mediaType: 'image/jpeg',
    });
  });

  it('refuses bytes that disagree with the declaration', async () => {
    const { resolution, warn } = await resolveWith(JPEG, 'image/jpeg', 'image/png');
    expect(resolution).toEqual({
      ok: false,
      reason: 'they are image/jpeg, but the image is declared image/png',
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('refuses a payload mimeType that disagrees with the bytes', async () => {
    const { resolution } = await resolveWith(PNG, 'image/webp', 'image/png');
    expect(resolution).toEqual({
      ok: false,
      reason: 'they are image/png, but their payload says image/webp',
    });
  });

  it('refuses a payload mimeType outside the three, even over agreeing bytes', async () => {
    const { resolution } = await resolveWith(PNG, 'application/octet-stream', 'image/png');
    expect(resolution).toMatchObject({ ok: false });
  });

  it('refuses when the payload and the declaration agree with each other but not the bytes', async () => {
    const { resolution } = await resolveWith(WEBP, 'image/png', 'image/png');
    expect(resolution).toEqual({
      ok: false,
      reason: 'they are image/webp, but the image is declared image/png',
    });
  });

  it.each([
    ['gif', GIF],
    ['text', TEXT],
  ])('refuses %s bytes, which are no image it can show', async (_label, bytes) => {
    const { resolution } = await resolveWith(bytes, 'image/png', 'image/png');
    expect(resolution).toEqual({ ok: false, reason: 'they are not a png, jpeg or webp image' });
  });

  it('refuses a payload with no bytes', async () => {
    const { ctx } = ctxReading({ mimeType: 'image/png' });
    const resolution = await toolImageResolver(ctx)(stepImage('image/png'));
    expect(resolution).toMatchObject({ ok: false });
  });

  it('answers not-ok, never throws, when the read itself fails', async () => {
    const ctx = {
      ...ctxReading({}).ctx,
      readPayload: async () => {
        throw new Error('store unavailable');
      },
    } as unknown as ExecutorContext;
    await expect(toolImageResolver(ctx)(stepImage('image/png'))).resolves.toEqual({
      ok: false,
      reason: 'store unavailable',
    });
  });
});
