/**
 * The chat renders generated media from the assets a media operation returns.
 * A shape drift here shows up as a JSON blob in the transcript, not as an
 * error, so the contract is pinned against the real output shape.
 */
import { describe, it, expect } from 'vitest';
import { extractDisplayContent, extractMediaItems } from './content-extraction.js';

const mediaOutput = {
  assets: [
    {
      assetId: '49c2b5b5f75586331bfbd3c1-0',
      candidateIndex: 0,
      docId: '3f1c9a52-2b7e-4c31-9c0d-8a2f4e6b1d70',
      path: '/media/run-1/take-49c2b5b5f75586331bfbd3c1-0.png',
      version: 1,
      contentHash: 'sha256:beef',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 812_004,
      revisedPrompt: 'A sunset over mountains, oil painting style',
      providerNative: { status: 'none', reason: 'route_issues_none' },
    },
  ],
  receipt: { provider: 'openai' },
  receiptRef: { path: '/media/run-1/take-49c2b5b5f75586331bfbd3c1.receipt.json' },
};

describe('extractMediaItems', () => {
  it('reads the renderable half of each asset, keyed by its document id', () => {
    expect(extractMediaItems(mediaOutput)).toEqual([
      {
        kind: 'image',
        mimeType: 'image/png',
        docId: '3f1c9a52-2b7e-4c31-9c0d-8a2f4e6b1d70',
        revisedPrompt: 'A sunset over mountains, oil painting style',
      },
    ]);
  });

  it('ignores an assets array whose entries carry no document to read bytes from', () => {
    expect(extractMediaItems({ assets: [{ kind: 'image', mimeType: 'image/png' }] })).toBeNull();
    expect(extractMediaItems({ assets: [] })).toBeNull();
    expect(extractMediaItems({ receipt: {} })).toBeNull();
  });
});

describe('extractDisplayContent', () => {
  it('renders a media output as media rather than as JSON', () => {
    const inline = extractDisplayContent({ kind: 'inline', value: mediaOutput });
    expect(inline?.mediaItems).toHaveLength(1);
    expect(inline?.richData).toBeUndefined();
  });

  it('renders media from a payload preview the same way', () => {
    const preview = extractDisplayContent({
      kind: 'ref',
      payloadRef: 'payload:tenant:abc123',
      preview: { json: mediaOutput },
    });
    expect(preview?.mediaItems).toHaveLength(1);
  });
});
