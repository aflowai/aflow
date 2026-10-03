/**
 * A media output outgrows the inline budget as soon as a route reports the
 * prompts it rewrote, so the chat draws it from the preview rather than from
 * the value. These cases hold the preview to carrying the assets — the fields
 * the player addresses a stored file by — whatever else the output holds and
 * whatever order its keys arrive in.
 */
import { describe, it, expect } from 'vitest';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import { deriveMediaAssetId } from '@aflow/schemas';
import type { SessionId, StepExecutionId, TenantId } from '@aflow/schemas';
import { resolveOutputToValueRef } from '../runtimeState.js';

const TENANT = 'tenant-media-preview' as TenantId;
const SESSION = 'run-media-preview' as SessionId;
const STEP = 'step-media-preview' as StepExecutionId;
const REQUEST_KEY =
  'run-media-preview|step-media-preview|0|ai.media.image|openai|gpt-image-2.5-sunburst|ab';
const DOC_IDS = [
  '3f1c9a52-2b7e-4c31-9c0d-8a2f4e6b1d70',
  '8b2d0f14-77aa-4a51-9c6e-1e5f3c8a9b21',
  'c4e91a06-5d33-4f88-a1b2-6d7e8f90a1b2',
  'd57b2e18-9f04-4a2c-8e35-2b1c7d6e5f40',
  'e9a3c7d2-1b46-4e90-b8f7-3c5d9e0a2b64',
];
const INLINE_BUDGET_BYTES = 32768;

function asset(candidateIndex: number) {
  return {
    assetId: deriveMediaAssetId(REQUEST_KEY, candidateIndex),
    candidateIndex,
    docId: DOC_IDS[candidateIndex],
    path: `/media/${SESSION}/take-${deriveMediaAssetId(REQUEST_KEY, candidateIndex)}`,
    version: 1,
    contentHash: `sha256:candidate-${String(candidateIndex)}`,
    kind: 'image' as const,
    mimeType: 'image/png',
    sizeBytes: 2_400_000,
    revisedPrompt: `a lantern-lit workshop, ${'rendered in oil '.repeat(600)}`,
    providerNative: { status: 'none', reason: 'route_issues_none' },
  };
}

/** One provider request, rendered as the candidate set the schema allows. */
const CANDIDATES = DOC_IDS.map((_, candidateIndex) => asset(candidateIndex));

function receipt() {
  return {
    execution: {
      runId: SESSION,
      stepExecutionId: STEP,
      attempt: 0,
      requestKey: REQUEST_KEY,
    },
    request: {
      prompt: 'a lantern-lit workshop',
      parameters: { size: '1024x1024', n: DOC_IDS.length },
      boundEntityVersions: [],
    },
    provider: 'openai',
    model: 'gpt-image-2.5-sunburst',
    capabilityRoute: { routeId: 'openai:gpt-image-2.5-sunburst:sync' },
    cost: { actual: { currency: 'USD', micros: 80_000 } },
    rendered: { width: 1024, height: 1024 },
    createdAt: '2026-08-18T10:00:00.000Z',
  };
}

const receiptRef = {
  path: `/media/${SESSION}/take-receipt.json`,
  version: 1,
  contentHash: 'sha256:receipt',
};

async function previewOf(output: Record<string, unknown>): Promise<Record<string, unknown>> {
  expect(
    JSON.stringify(output).length,
    'the case only exercises the preview path if the output outgrows the inline budget',
  ).toBeGreaterThan(INLINE_BUDGET_BYTES);

  const store = createMemoryPayloadStore();
  const ref = await store.store({
    tenantId: TENANT,
    runId: SESSION,
    stepExecutionId: STEP,
    attempt: 0,
    kind: 'output',
    data: output,
  });
  const resolved = await resolveOutputToValueRef(store, ref, undefined);
  expect(resolved['kind']).toBe('ref');
  return (resolved['preview'] as { json: Record<string, unknown> }).json;
}

describe('the preview of a media output too large to inline', () => {
  it('carries every candidate of the request, with the document each is read from', async () => {
    const json = await previewOf({ assets: CANDIDATES, receipt: receipt(), receiptRef });

    expect(
      json['assets'],
      'a candidate dropped here is one the operation charged for and the chat never shows',
    ).toEqual(
      DOC_IDS.map((docId) =>
        expect.objectContaining({ kind: 'image', mimeType: 'image/png', docId }),
      ),
    );
  });

  it('keeps the assets when they are the last key rather than the first', async () => {
    const json = await previewOf({ receiptRef, receipt: receipt(), assets: CANDIDATES });

    expect(
      (json['assets'] as Array<{ docId: string }>).map((entry) => entry.docId),
      'a key reorder must not be able to empty the media strip',
    ).toEqual(DOC_IDS);
  });

  it('bounds the rewritten prompt it carries instead of copying the whole one', async () => {
    const json = await previewOf({ assets: CANDIDATES, receipt: receipt(), receiptRef });

    const [first] = json['assets'] as Array<{ revisedPrompt: string }>;
    expect(first?.revisedPrompt.startsWith('a lantern-lit workshop, ')).toBe(true);
    expect(first?.revisedPrompt.length).toBeLessThan(200);
    expect(JSON.stringify(json).length).toBeLessThan(INLINE_BUDGET_BYTES);
  });

  it('leaves an output with no assets to the generic truncated preview', async () => {
    const json = await previewOf({
      rows: Array.from({ length: 400 }, (_, index) => ({
        id: index,
        note: 'x'.repeat(120),
      })),
    });

    expect(json['assets']).toBeUndefined();
    expect(json['rows']).toBeDefined();
  });
});
