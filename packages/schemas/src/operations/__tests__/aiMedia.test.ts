import { describe, it, expect } from 'vitest';
import {
  getOperation,
  getOperationCapability,
  deriveCapabilityGroups,
} from '../../catalog/registry.js';
import {
  AiImageEditInputSchema as EDIT_INPUT,
  AiImageGenerateInputSchema,
  AiVideoFromImageInputSchema as ANIMATE_INPUT,
  MAX_IMAGE_REFERENCES,
  MAX_IMAGE_REFERENCES_PER_ROLE,
} from '../ai.js';

const pinnedRef = {
  path: '/media/run-1/take-9f2c1a-0',
  version: 2,
  contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

const MEDIA_OPERATIONS = [
  'ai.media.image',
  'ai.media.edit_image',
  'ai.media.video',
  'ai.media.animate',
] as const;

describe('ai.media.* access mode', () => {
  it.each(MEDIA_OPERATIONS)('registers %s as a write', (operationId) => {
    expect(getOperation(operationId)?.accessMode).toBe('write');
  });

  it.each(MEDIA_OPERATIONS)('derives the ai.media:write capability for %s', (operationId) => {
    expect(getOperationCapability(operationId)).toMatchObject({
      capabilityGroupId: 'ai.media',
      accessMode: 'write',
    });
  });

  it('leaves the ai.media group with no read mode to grant', () => {
    expect(deriveCapabilityGroups().get('ai.media')?.supportedAccessModes).toEqual(['write']);
  });
});

describe('ai.media async-job ownership', () => {
  it.each(['ai.media.video', 'ai.media.animate'])(
    'declares that %s drives a provider job past the end of its request',
    (operationId) => {
      expect(getOperation(operationId)?.ownsAsyncJobLifecycle).toBe(true);
    },
  );

  it.each(['ai.media.image', 'ai.media.edit_image'])(
    'leaves %s out of it — its provider call returns inside the request',
    (operationId) => {
      expect(getOperation(operationId)?.ownsAsyncJobLifecycle).toBe(false);
    },
  );
});

function reference(role: 'character' | 'style', index: number) {
  return { ref: `inline:ref-${role}-${String(index)}`, role };
}

function references(role: 'character' | 'style', count: number) {
  return Array.from({ length: count }, (_, index) => reference(role, index));
}

describe('AiImageGenerateInputSchema.referenceRefs', () => {
  // The literals are the published per-role ceilings of the most
  // reference-capable route. Every case that builds its input from the constant
  // compares the constant with itself and survives any edit to it; these do not.
  it('pins the ceilings to the numbers the reference-capable route honours', () => {
    expect(MAX_IMAGE_REFERENCES_PER_ROLE).toEqual({ character: 5, style: 3 });
    expect(MAX_IMAGE_REFERENCES).toBe(8);
  });

  it('accepts five character and three style references', () => {
    const parsed = AiImageGenerateInputSchema.safeParse({
      prompt: 'Ada at the workbench',
      referenceRefs: [...references('character', 5), ...references('style', 3)],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a sixth character reference', () => {
    const parsed = AiImageGenerateInputSchema.safeParse({
      prompt: 'Ada at the workbench',
      referenceRefs: references('character', 6),
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a fourth style reference', () => {
    const parsed = AiImageGenerateInputSchema.safeParse({
      prompt: 'Ada at the workbench',
      referenceRefs: references('style', 4),
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a labelled reference list at the per-role limits', () => {
    const parsed = AiImageGenerateInputSchema.safeParse({
      prompt: 'Ada at the workbench',
      referenceRefs: [
        { ref: 'inline:ada', role: 'character', label: 'Ada' },
        ...references('character', MAX_IMAGE_REFERENCES_PER_ROLE.character - 1),
        ...references('style', MAX_IMAGE_REFERENCES_PER_ROLE.style),
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('is optional — a prompt-only generation still parses', () => {
    expect(AiImageGenerateInputSchema.safeParse({ prompt: 'A sunset' }).success).toBe(true);
  });

  it('rejects more character references than any route honours', () => {
    const parsed = AiImageGenerateInputSchema.safeParse({
      prompt: 'Ada at the workbench',
      referenceRefs: references('character', MAX_IMAGE_REFERENCES_PER_ROLE.character + 1),
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('character references exceeds the limit');
  });

  it('rejects more style references than any route honours', () => {
    const parsed = AiImageGenerateInputSchema.safeParse({
      prompt: 'Ada at the workbench',
      referenceRefs: references('style', MAX_IMAGE_REFERENCES_PER_ROLE.style + 1),
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('style references exceeds the limit');
  });

  it('rejects a list longer than any role split can produce', () => {
    const parsed = AiImageGenerateInputSchema.safeParse({
      prompt: 'Ada at the workbench',
      referenceRefs: references('character', MAX_IMAGE_REFERENCES + 1),
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a role the provider has no mapping for', () => {
    const parsed = AiImageGenerateInputSchema.safeParse({
      prompt: 'Ada at the workbench',
      referenceRefs: [{ ref: 'inline:plate', role: 'lighting' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts the pinned reference a render returns, straight through', () => {
    const parsed = AiImageGenerateInputSchema.safeParse({
      prompt: 'Ada at the workbench',
      referenceRefs: [{ ref: pinnedRef, role: 'character', label: 'Ada' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a bare path, which names no version to read', () => {
    const parsed = AiImageGenerateInputSchema.safeParse({
      prompt: 'Ada at the workbench',
      referenceRefs: [{ ref: { path: '/media/run-1/take-abc-0' }, role: 'character' }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('media source references reach the agent', () => {
  it.each(MEDIA_OPERATIONS)('hides no input field of %s from the tool surface', (operationId) => {
    expect(getOperation(operationId)?.internalFields?.input ?? []).toEqual([]);
  });

  it.each([
    ['ai.media.edit_image', 'imageRef'],
    ['ai.media.animate', 'imageRef'],
  ] as const)('takes a pinned reference on %s.%s', (operationId, field) => {
    const schema = operationId === 'ai.media.edit_image' ? EDIT_INPUT : ANIMATE_INPUT;
    expect(schema.safeParse({ prompt: 'zoom out', [field]: pinnedRef }).success).toBe(true);
    expect(schema.safeParse({ prompt: 'zoom out', [field]: 'payload:t:abc' }).success).toBe(true);
    expect(schema.safeParse({ prompt: 'zoom out', [field]: { path: '/x' } }).success).toBe(false);
  });
});
