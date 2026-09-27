import { describe, it, expect } from 'vitest';
import {
  AiMediaOutputSchema,
  MediaAssetSchema,
  MediaReceiptDocumentSchema,
  ProviderNativeHandleSchema,
  deriveMediaAssetId,
  mediaRenderParameters,
  type MediaAsset,
  type MediaGenerationReceipt,
} from '../asset.js';
import { deriveAsyncJobKey } from '../../runtime/asyncJob.js';
import { MemoryGetInputSchema } from '../../operations/memory.js';
import { getOperation } from '../../catalog/registry.js';
import { toJsonSchemaSync } from '../../utils/jsonSchema.js';

const REQUEST_KEY = 'run-1|step-1|0|ai.media.video|google|veo-3.1|abc123';

function asset(candidateIndex: number, overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    assetId: deriveMediaAssetId(REQUEST_KEY, candidateIndex),
    candidateIndex,
    path: `/projects/ad/shots/s1/take-${String(candidateIndex)}.mp4`,
    version: 1,
    contentHash: 'sha256:beef',
    docId: '3f1c9a52-2b7e-4c31-9c0d-8a2f4e6b1d70',
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 20_000_000,
    providerNative: { status: 'none', reason: 'route_issues_none' },
    ...overrides,
  };
}

function receipt(overrides: Partial<MediaGenerationReceipt> = {}): MediaGenerationReceipt {
  return {
    execution: {
      runId: 'run-1',
      logicalExecutionId: 'step-1',
      attempt: 0,
      requestKey: REQUEST_KEY,
      providerJobId: 'projects/x/operations/y',
    },
    request: {
      prompt: 'Ada crosses the workshop',
      negativePrompt: 'on-screen text',
      parameters: { durationSeconds: 8, aspectRatio: '16:9', resolution: '1080p' },
      boundEntityVersions: [
        {
          path: '/entities/characters/ada/refs/front.png',
          version: 3,
          contentHash: 'sha256:ada3',
          role: 'character',
          label: 'Ada',
        },
      ],
    },
    provider: 'google',
    model: 'veo-3.1-generate-preview',
    capabilityRoute: { routeId: 'google:veo-3.1', requestedModel: 'veo-3.1' },
    cost: { actual: { currency: 'USD', micros: 1_200_000 } },
    rendered: { width: 1920, height: 1080, durationSeconds: 8 },
    createdAt: '2026-08-18T10:00:00.000Z',
    ...overrides,
  };
}

function output(assets: MediaAsset[], receiptOverrides: Partial<MediaGenerationReceipt> = {}) {
  return {
    assets,
    receipt: receipt(receiptOverrides),
    receiptRef: {
      path: '/projects/ad/shots/s1/take-0.receipt.json',
      version: 1,
      contentHash: 'sha256:receipt',
    },
  };
}

describe('the pinned asset reference', () => {
  it('resolves as a memory.store.get target without carrying bytes', () => {
    const parsed = MediaAssetSchema.parse(asset(0));
    const read = MemoryGetInputSchema.safeParse({
      target: {
        path: parsed.path,
        version: parsed.version,
        expectedContentHash: parsed.contentHash,
      },
      view: 'stat',
    });
    expect(read.success).toBe(true);
    expect(read.data).toMatchObject({
      target: { path: parsed.path, version: 1, expectedContentHash: 'sha256:beef' },
    });
  });

  it('drops base64 data handed to it — the bytes have nowhere to live', () => {
    const parsed = MediaAssetSchema.parse({ ...asset(0), data: 'AAAA', url: 'https://x/y.mp4' });
    expect(parsed).not.toHaveProperty('data');
    expect(parsed).not.toHaveProperty('url');
  });

  it.each(['path', 'version', 'contentHash'] as const)(
    'refuses a reference missing %s — two of the three cannot pin bytes',
    (field) => {
      const incomplete: Record<string, unknown> = { ...asset(0) };
      delete incomplete[field];
      expect(MediaAssetSchema.safeParse(incomplete).success).toBe(false);
    },
  );

  it('carries the document id the ranged byte read is addressed by', () => {
    expect(MediaAssetSchema.parse(asset(0)).docId).toBe('3f1c9a52-2b7e-4c31-9c0d-8a2f4e6b1d70');
    const withoutDocId: Record<string, unknown> = { ...asset(0) };
    delete withoutDocId['docId'];
    expect(MediaAssetSchema.safeParse(withoutDocId).success).toBe(false);
  });
});

describe('provider-native handle', () => {
  it('accepts the one answer every route behind these operations gives', () => {
    expect(
      ProviderNativeHandleSchema.safeParse({ status: 'none', reason: 'route_issues_none' }).success,
    ).toBe(true);
  });

  it('refuses an issued handle — no route hands one back for a step to record', () => {
    expect(
      ProviderNativeHandleSchema.safeParse({
        status: 'issued',
        handle: 'veo/op/abc',
        expiresAt: '2999-01-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('refuses an absent handle with no reason', () => {
    expect(ProviderNativeHandleSchema.safeParse({ status: 'none' }).success).toBe(false);
  });
});

describe('candidate identity', () => {
  it('derives the same asset id from the async job key of the same request', () => {
    const key = deriveAsyncJobKey({
      runId: 'run-1',
      logicalExecutionId: 'step-1',
      attempt: 0,
      operationId: 'ai.media.video',
      provider: 'google',
      model: 'veo-3.1',
      inputHash: 'abc123',
    });
    expect(key).toBe(REQUEST_KEY);
    expect(deriveMediaAssetId(key, 0)).toBe('49c2b5b5f75586331bfbd3c1-0');
    expect(deriveMediaAssetId(key, 1)).toBe('49c2b5b5f75586331bfbd3c1-1');
  });

  it('accepts several candidates of one request under one receipt', () => {
    const parsed = AiMediaOutputSchema.safeParse(output([asset(0), asset(1)]));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.assets.map((a) => a.assetId)).toEqual([
      '49c2b5b5f75586331bfbd3c1-0',
      '49c2b5b5f75586331bfbd3c1-1',
    ]);
  });

  it('rejects an asset id minted outside the derivation', () => {
    const parsed = AiMediaOutputSchema.safeParse(
      output([asset(0, { assetId: 'e6f0a5b4-1c2d-4f3e-9a8b-7c6d5e4f3a2b' })]),
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('breaks retry adoption');
  });

  it('rejects candidates whose ids come from a different request', () => {
    const foreign = deriveMediaAssetId('some-other-request', 0);
    expect(AiMediaOutputSchema.safeParse(output([asset(0, { assetId: foreign })])).success).toBe(
      false,
    );
  });

  it('rejects a repeated candidate index', () => {
    const parsed = AiMediaOutputSchema.safeParse(output([asset(0), asset(0)]));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['assets', 1, 'candidateIndex']);
  });

  it('rejects a gap in the candidate sequence', () => {
    expect(AiMediaOutputSchema.safeParse(output([asset(0), asset(2)])).success).toBe(false);
  });

  it('rejects a production with no asset at all', () => {
    expect(AiMediaOutputSchema.safeParse(output([])).success).toBe(false);
  });

  it('holds the durable receipt document to the same addressing', () => {
    expect(
      MediaReceiptDocumentSchema.safeParse({ assets: [asset(0)], receipt: receipt() }).success,
    ).toBe(true);
    expect(
      MediaReceiptDocumentSchema.safeParse({
        assets: [asset(0, { assetId: 'take-0' })],
        receipt: receipt(),
      }).success,
    ).toBe(false);
  });
});

describe('the receipt', () => {
  it('records money as a currency and integer micros', () => {
    expect(
      AiMediaOutputSchema.safeParse(
        output([asset(0)], { cost: { actual: { currency: 'USD', micros: 1.5 } } }),
      ).success,
    ).toBe(false);
    const priced = AiMediaOutputSchema.parse(
      output([asset(0)], {
        cost: {
          quoted: { currency: 'USD', micros: 1_000_000 },
          actual: { currency: 'USD', micros: 1_200_000 },
        },
      }),
    );
    expect(priced.receipt.cost).toEqual({
      quoted: { currency: 'USD', micros: 1_000_000 },
      actual: { currency: 'USD', micros: 1_200_000 },
    });
  });

  it('accepts an unpriced render by omitting the cost rather than reporting zero', () => {
    const parsed = AiMediaOutputSchema.parse(output([asset(0)], { cost: {} }));
    expect(parsed.receipt.cost.actual).toBeUndefined();
  });

  it('carries the render parameters, leaving out what it records in its own right', () => {
    expect(
      mediaRenderParameters({
        prompt: 'Ada crosses the workshop',
        negativePrompt: 'on-screen text',
        durationSeconds: 8,
        aspectRatio: '16:9',
        imageMimeType: 'image/png',
        imageData: 'A'.repeat(4096),
        references: [{ role: 'character' }],
        resolution: undefined,
      }),
    ).toEqual({ durationSeconds: 8, aspectRatio: '16:9', imageMimeType: 'image/png' });
  });

  it('carries the pinned versions the render read, not just their paths', () => {
    const parsed = AiMediaOutputSchema.parse(output([asset(0)]));
    expect(parsed.receipt.request.boundEntityVersions[0]).toMatchObject({
      path: '/entities/characters/ada/refs/front.png',
      version: 3,
      contentHash: 'sha256:ada3',
      role: 'character',
    });
  });

  it('rejects a bound entity given as a path alone', () => {
    expect(
      AiMediaOutputSchema.safeParse(
        output([asset(0)], {
          request: {
            prompt: 'Ada crosses the workshop',
            parameters: {},
            boundEntityVersions: [
              { path: '/entities/characters/ada/refs/front.png', role: 'character' },
            ],
          },
        } as unknown as Partial<MediaGenerationReceipt>),
      ).success,
    ).toBe(false);
  });
});

describe('the media operations', () => {
  const MEDIA_OPERATIONS = [
    'ai.media.image',
    'ai.media.edit_image',
    'ai.media.video',
    'ai.media.animate',
  ] as const;

  it.each(MEDIA_OPERATIONS)('publishes references and a receipt for %s, never bytes', (opId) => {
    const outputZod = getOperation(opId)?.outputZod;
    expect(outputZod).toBeDefined();
    const jsonSchema = toJsonSchemaSync(outputZod!, { definitions: true }) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(jsonSchema.properties ?? {}).sort()).toEqual([
      'assets',
      'receipt',
      'receiptRef',
    ]);
    expect(jsonSchema.required).toEqual(
      expect.arrayContaining(['assets', 'receipt', 'receiptRef']),
    );
  });
});
