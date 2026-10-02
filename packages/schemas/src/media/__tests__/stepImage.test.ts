import { describe, it, expect } from 'vitest';
import {
  MAX_STEP_IMAGES_PER_OUTPUT,
  STEP_IMAGE_SEARCH_DEPTH,
  StepImageSchema,
  findStepImages,
  type StepImage,
} from '../stepImage.js';
import {
  AiContentPartSchema,
  AiToolResultEnvelopeV1Schema,
  toolResultMessage,
  type AiToolResultEnvelopeV1,
} from '../../runtime/aiPrompt.js';
import { estimateMessageTokens } from '../../runtime/tokenEstimate.js';

const ref = `inline:${Buffer.from(JSON.stringify({ data: 'iVBORw0KGgo=', mimeType: 'image/png' })).toString('base64')}`;

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

describe('findStepImages', () => {
  it('finds the output itself when it is the image', () => {
    expect(findStepImages(screenshot)).toEqual([screenshot]);
  });

  it('finds images nested in objects and arrays, in document order', () => {
    const second = { ...screenshot, description: 'The dashboard' };
    expect(
      findStepImages({ url: 'https://example.com', page: { image: screenshot }, more: [second] }),
    ).toEqual([screenshot, second]);
  });

  it('finds nothing in an output with no image', () => {
    expect(findStepImages({ text: 'hello', ref, contentType: 'image/png' })).toEqual([]);
    expect(findStepImages('plain')).toEqual([]);
    expect(findStepImages(null)).toEqual([]);
  });

  it('stops at the depth bound', () => {
    let deep: unknown = screenshot;
    for (let i = 0; i < STEP_IMAGE_SEARCH_DEPTH; i++) deep = { inner: deep };
    expect(findStepImages(deep)).toEqual([screenshot]);
    expect(findStepImages({ inner: deep })).toEqual([]);
  });

  it('stops at the count bound', () => {
    const many = Array.from({ length: MAX_STEP_IMAGES_PER_OUTPUT + 3 }, () => screenshot);
    expect(findStepImages(many)).toHaveLength(MAX_STEP_IMAGES_PER_OUTPUT);
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
