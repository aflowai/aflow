import { describe, it, expect } from 'vitest';
import {
  MAX_STEP_IMAGES_PER_OUTPUT,
  StepImageOutputPathsSchema,
  StepImageSchema,
  findStepImages,
  stubStepImages,
  type StepImage,
} from '../stepImage.js';
import {
  AiContentPartSchema,
  AiToolResultEnvelopeV1Schema,
  toolResultMessage,
  type AiToolResultEnvelopeV1,
} from '../../runtime/aiPrompt.js';
import { estimateMessageTokens } from '../../runtime/tokenEstimate.js';

const producer = { tenantId: 'tenant-1', runId: 'run-1', stepExecutionId: 'exec-1' };
const ref = 'gs://aflow-payloads/tenants/tenant-1/runs/run-1/steps/exec-1/attempt/1/body.json';
const inlineRef = `inline:${Buffer.from(JSON.stringify({ data: 'iVBORw0KGgo=', mimeType: 'image/png' })).toString('base64')}`;

const screenshot: StepImage = {
  ref,
  contentType: 'image/png',
  sizeBytes: 48_213,
  width: 1280,
  height: 720,
  description: 'The sign-in page with the email field focused',
};

const envelope: AiToolResultEnvelopeV1 = {
  kind: 'tool_result',
  toolCallId: 'abc_0',
  toolName: 'browser.page.screenshot',
  status: 'SUCCEEDED',
  completedAtMs: 1,
  summary: 'Captured the page',
};

describe('StepImageSchema', () => {
  it('accepts the shape a screenshot returns, with and without a description', () => {
    expect(StepImageSchema.parse(screenshot)).toEqual(screenshot);
    const { description: _description, ...bare } = screenshot;
    expect(StepImageSchema.safeParse(bare).success).toBe(true);
  });

  it.each(['image/png', 'image/jpeg', 'image/webp'])('accepts %s', (contentType) => {
    expect(StepImageSchema.safeParse({ ...screenshot, contentType }).success).toBe(true);
  });

  it.each([
    ['a content type outside png, jpeg and webp', { contentType: 'image/gif' }],
    ['a reference that is not a PayloadRef', { ref: 'https://example.com/a.png' }],
    ['a description over one line', { description: 'first line\nsecond line' }],
    ['a description over the length bound', { description: 'x'.repeat(201) }],
    ['a zero width', { width: 0 }],
    ['a fractional byte size', { sizeBytes: 1.5 }],
    ['an unknown key', { bytes: 'iVBORw0KGgo=' }],
  ])('refuses %s', (_label, change) => {
    expect(StepImageSchema.safeParse({ ...screenshot, ...change }).success).toBe(false);
  });
});

describe('StepImageOutputPathsSchema', () => {
  it('accepts names, dotted names and arrays', () => {
    expect(
      StepImageOutputPathsSchema.safeParse(['image', 'page.screenshot', 'frames[]']).success,
    ).toBe(true);
  });

  it.each([
    ['no path', []],
    ['an empty path', ['']],
    ['a bracketed index', ['frames[0]']],
    ['a wildcard', ['*']],
    ['a leading dot', ['.image']],
    ['a repeated path', ['image', 'image']],
  ])('refuses %s', (_label, paths) => {
    expect(StepImageOutputPathsSchema.safeParse(paths).success).toBe(false);
  });
});

describe('findStepImages', () => {
  const second = { ...screenshot, description: 'The dashboard' };

  it('reads the declared paths, in declaration order', () => {
    const output = { url: 'https://example.com', page: { image: screenshot }, frames: [second] };
    expect(findStepImages(output, ['frames[]', 'page.image'], producer)).toEqual({
      images: [second, screenshot],
      withheld: [],
    });
  });

  it('reads nothing outside them, however the value is shaped', () => {
    const output = { image: 'not an image', nested: { image: screenshot }, list: [screenshot] };
    expect(findStepImages(output, ['image'], producer)).toEqual({ images: [], withheld: [] });
    expect(findStepImages(screenshot, ['image'], producer)).toEqual({ images: [], withheld: [] });
    expect(findStepImages('plain', ['image'], producer)).toEqual({ images: [], withheld: [] });
    expect(findStepImages(null, ['image'], producer)).toEqual({ images: [], withheld: [] });
  });

  it('reads only own properties', () => {
    const inherited = Object.create({ image: screenshot }) as object;
    expect(findStepImages(inherited, ['image'], producer).images).toEqual([]);
  });

  it.each([
    ['another step execution', ref.replace('/steps/exec-1/', '/steps/exec-2/')],
    ['another run', ref.replace('/runs/run-1/', '/runs/run-2/')],
    ['another tenant', ref.replace('/tenants/tenant-1/', '/tenants/tenant-2/')],
    [
      'content-addressed bytes',
      `gs://aflow-payloads/tenants/tenant-1/content/${'a'.repeat(64)}/body.json`,
    ],
  ])('withholds an image whose reference names %s', (_label, foreign) => {
    expect(findStepImages({ image: { ...screenshot, ref: foreign } }, ['image'], producer)).toEqual(
      {
        images: [],
        withheld: [
          'The image at image was not shown: its reference names a payload this step did not store.',
        ],
      },
    );
  });

  it('withholds an inline image, naming the element it was', () => {
    const output = { frames: [screenshot, { ...screenshot, ref: inlineRef }] };
    expect(findStepImages(output, ['frames[]'], producer)).toEqual({
      images: [screenshot],
      withheld: [
        'The image at frames[1] was not shown: it is carried inline, not stored by this step.',
      ],
    });
  });

  it('stops at the count bound, withheld images included', () => {
    const frames = Array.from({ length: MAX_STEP_IMAGES_PER_OUTPUT + 3 }, () => screenshot);
    const found = findStepImages(
      { image: { ...screenshot, ref: inlineRef }, frames },
      ['image', 'frames[]'],
      producer,
    );
    expect(found.withheld).toHaveLength(1);
    expect(found.images).toHaveLength(MAX_STEP_IMAGES_PER_OUTPUT - 1);
  });
});

describe('toolResultMessage', () => {
  it('leaves an envelope without images exactly as it was', () => {
    const message = toolResultMessage(envelope);
    expect(JSON.stringify(message)).toBe(
      JSON.stringify({
        role: 'tool',
        toolCallId: 'abc_0',
        name: 'browser.page.screenshot',
        parts: [{ kind: 'json', json: envelope }],
      }),
    );
  });

  it('carries each image as an image part beside the envelope', () => {
    const withImage = AiToolResultEnvelopeV1Schema.parse({ ...envelope, images: [screenshot] });
    const message = toolResultMessage(withImage);
    expect(message.parts).toEqual([
      { kind: 'json', json: envelope },
      { kind: 'image', ...screenshot },
    ]);
    for (const part of message.parts) {
      expect(AiContentPartSchema.safeParse(part).success).toBe(true);
    }
  });

  it('counts an image part toward the message estimate', () => {
    const plain = estimateMessageTokens(toolResultMessage(envelope));
    const withImage = estimateMessageTokens(
      toolResultMessage({ ...envelope, images: [screenshot] }),
    );
    expect(withImage - plain).toBeGreaterThan(1000);
  });
});

describe('stubStepImages', () => {
  const { ref: _ref, ...stub } = screenshot;

  it('replaces every image at a declared path with all of it but the reference', () => {
    const output = {
      url: 'https://example.com',
      image: screenshot,
      frames: [screenshot, { ...screenshot, ref: inlineRef }, 'not an image'],
      elsewhere: screenshot,
    };
    expect(stubStepImages(output, ['image', 'frames[]'])).toEqual({
      url: 'https://example.com',
      image: stub,
      frames: [stub, stub, 'not an image'],
      elsewhere: screenshot,
    });
  });

  it('stubs past the count of images carried', () => {
    const frames = Array.from({ length: MAX_STEP_IMAGES_PER_OUTPUT + 3 }, () => screenshot);
    const stubbed = stubStepImages({ frames }, ['frames[]']) as { frames: unknown[] };
    expect(stubbed.frames).toHaveLength(frames.length);
    expect(JSON.stringify(stubbed)).not.toContain('gs://');
  });

  it('leaves the output it was given as it was, and a missing path alone', () => {
    const output = { image: screenshot };
    expect(stubStepImages(output, ['page.image', 'frames[]'])).toBe(output);
    stubStepImages(output, ['image']);
    expect(output.image).toBe(screenshot);
  });
});
