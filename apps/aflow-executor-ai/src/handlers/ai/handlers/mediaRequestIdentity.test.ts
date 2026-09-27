/**
 * The job identity decides whether a retry adopts a paid render or buys another
 * one, so it has to move with every field the provider is handed.
 */
import { describe, it, expect } from 'vitest';
import { hashMediaRequest } from './mediaRequestIdentity.js';
import type { VideoJobSpec } from './videoJobRunner.js';

type VideoRequest = VideoJobSpec['request'];

const MODEL = 'veo-3.1-generate-preview';

/**
 * `Required` is the coverage requirement: a field added to the request is a
 * type error here until this carries it, and the loop below then fails until
 * the identity reaches it.
 */
const EVERY_FIELD: Required<VideoRequest> = {
  prompt: 'a drone shot over a tropical beach at sunset',
  negativePrompt: 'on-screen text',
  durationSeconds: 8,
  aspectRatio: '16:9',
  resolution: '1080p',
  imageData: 'Zmlyc3QtZnJhbWU=',
  imageMimeType: 'image/png',
  lastFrameData: 'bGFzdC1mcmFtZQ==',
  lastFrameMimeType: 'image/jpeg',
};

function changed(value: unknown): string | number {
  return typeof value === 'number' ? value + 1 : `${String(value)}-changed`;
}

describe('hashMediaRequest', () => {
  it('moves when any single field of the request moves', () => {
    const baseline = hashMediaRequest(MODEL, EVERY_FIELD);
    for (const field of Object.keys(EVERY_FIELD) as (keyof Required<VideoRequest>)[]) {
      const mutated: VideoRequest = { ...EVERY_FIELD, [field]: changed(EVERY_FIELD[field]) };
      expect(
        hashMediaRequest(MODEL, mutated),
        `"${field}" is sent to the provider but never reaches the job identity`,
      ).not.toBe(baseline);
    }
  });

  it('moves when the model moves', () => {
    expect(hashMediaRequest('veo-3.1-fast-generate-preview', EVERY_FIELD)).not.toBe(
      hashMediaRequest(MODEL, EVERY_FIELD),
    );
  });

  it('reads an unset field and one spelled out as undefined as the same render', () => {
    const minimal: VideoRequest = { prompt: EVERY_FIELD.prompt };
    const spelled: VideoRequest = {
      prompt: EVERY_FIELD.prompt,
      negativePrompt: undefined,
      durationSeconds: undefined,
      aspectRatio: undefined,
      resolution: undefined,
      imageData: undefined,
      imageMimeType: undefined,
      lastFrameData: undefined,
      lastFrameMimeType: undefined,
    };
    expect(hashMediaRequest(MODEL, spelled)).toBe(hashMediaRequest(MODEL, minimal));
  });

  it('does not depend on the order the fields were written in', () => {
    const reversed = Object.fromEntries(
      Object.entries(EVERY_FIELD).reverse(),
    ) as unknown as VideoRequest;
    expect(hashMediaRequest(MODEL, reversed)).toBe(hashMediaRequest(MODEL, EVERY_FIELD));
  });
});
