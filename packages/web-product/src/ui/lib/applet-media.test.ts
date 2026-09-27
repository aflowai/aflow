/**
 * The host half of the media channel — what an applet may see.
 *
 * The gate is the point of the file: a view is untrusted code, some of it
 * written by an agent, so the host serves the assets the instance's own state
 * pins and nothing else. The last test holds the gate open and shows the same
 * request being served, which is what makes the refusal tests mean anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPLET_MEDIA_MAX_ASSET_BYTES,
  APPLET_MEDIA_MAX_RESIDENT_BYTES,
  PHOENIX_APPLET_MEDIA_MESSAGE_TYPE,
  PHOENIX_APPLET_MEDIA_RELEASE_MESSAGE_TYPE,
  type AppletAssetPin,
} from '@aflow/schemas';
import { __resetForTests } from '../hooks/media-bytes-broker.js';

const gate = vi.hoisted(() => ({ heldOpen: false }));

vi.mock('@aflow/applet-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/applet-runtime')>();
  return {
    ...actual,
    appletStateReferencesAsset: (state: Record<string, unknown>, asset: AppletAssetPin) =>
      gate.heldOpen || actual.appletStateReferencesAsset(state, asset),
  };
});

const { createAppletMediaResponder } = await import('./applet-media');

const API = 'http://api.test';

/** Stable per-path document id, as a space's own read would answer. */
function docIdFor(path: string): string {
  return `doc-${path.replace(/[^a-z0-9]+/gi, '-')}`;
}
const TAKE: AppletAssetPin = {
  path: '/film/shots/sh_a1b2c3d4/take_2.mp4',
  version: 1,
  contentHash: 'f00dcafe1234',
};
const SALARIES: AppletAssetPin = {
  path: '/hr/salaries.csv',
  version: 1,
  contentHash: 'deadbeef9999',
};

const boardState = (): Record<string, unknown> => ({
  shots: { sh_a1b2c3d4: { selectedTake: { takeId: 't2', asset: TAKE, note: '' } } },
});

function request(asset: AppletAssetPin, requestId = '99999999-0000-0000-0000-000000000001') {
  return { type: PHOENIX_APPLET_MEDIA_MESSAGE_TYPE, requestId, asset };
}

/** The responder reads `size` and passes the Blob on — a real megabyte buffer proves nothing. */
function blobOf(size: number): Blob {
  return { size, type: 'video/mp4' } as unknown as Blob;
}

interface Served {
  sizeBytes: number;
  contentHash: string;
}

let fetched: string[];
let served: Served;
let missing: boolean;

function headers(): Record<string, string> {
  return { 'X-Tenant-ID': 'tenant-a', 'X-Space-ID': 'space-a', Authorization: 'Bearer t' };
}

function newResponder() {
  return createAppletMediaResponder({ apiUrl: API, headers });
}

beforeEach(() => {
  fetched = [];
  missing = false;
  served = { sizeBytes: 2_048, contentHash: TAKE.contentHash };
  vi.stubGlobal('fetch', (url: string) => {
    fetched.push(url);
    if (url.includes('/bytes')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(blobOf(served.sizeBytes)),
        headers: new Headers({ ETag: `"${served.contentHash}"`, 'Content-Type': 'video/mp4' }),
      } as unknown as Response);
    }
    const asked = new URL(url).searchParams.get('pathPrefix') ?? '';
    const items = missing
      ? []
      : [{ id: docIdFor(asked), path: asked, sizeBytes: served.sizeBytes }];
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ items, nextCursor: null }),
    } as unknown as Response);
  });
});

afterEach(() => {
  gate.heldOpen = false;
  __resetForTests();
  vi.unstubAllGlobals();
});

describe('the applet media channel', () => {
  it('serves an asset the board pins', async () => {
    const result = await newResponder().answer(request(TAKE), boardState());

    expect(result).toMatchObject({ status: 'ready', mimeType: 'video/mp4', sizeBytes: 2_048 });
    expect(result?.blob?.size).toBe(2_048);
    expect(fetched[0]).toContain(`pathPrefix=${encodeURIComponent(TAKE.path)}`);
    expect(fetched[1]).toBe(`${API}/memory/docs/${docIdFor(TAKE.path)}/bytes`);
  });

  it('refuses a document the board does not pin, and reads nothing to decide it', async () => {
    const result = await newResponder().answer(request(SALARIES), boardState());

    expect(result).toMatchObject({ status: 'refused', reason: 'not_referenced' });
    expect(result?.message).toContain(SALARIES.path);
    expect(result?.message).toContain('pins');
    expect(fetched).toEqual([]);
  });

  it('refuses an asset the board pinned at another version', async () => {
    const result = await newResponder().answer(request({ ...TAKE, version: 2 }), boardState());

    expect(result).toMatchObject({ status: 'refused', reason: 'not_referenced' });
    expect(fetched).toEqual([]);
  });

  it('refuses every asset while the platform holds no state for the instance', async () => {
    const result = await newResponder().answer(request(TAKE), undefined);

    expect(result).toMatchObject({ status: 'refused', reason: 'not_referenced' });
    expect(fetched).toEqual([]);
  });

  it('refuses bytes that are not the ones the board pinned', async () => {
    served = { ...served, contentHash: '99998888777766' };
    const result = await newResponder().answer(request(TAKE), boardState());

    expect(result).toMatchObject({ status: 'refused', reason: 'asset_changed' });
    expect(result?.message).toContain('rewritten');
  });

  it('refuses an asset past the size a frame may hold, before reading it', async () => {
    served = { ...served, sizeBytes: APPLET_MEDIA_MAX_ASSET_BYTES + 1 };
    const result = await newResponder().answer(request(TAKE), boardState());

    expect(result).toMatchObject({ status: 'refused', reason: 'too_large' });
    expect(fetched).toHaveLength(1);
  });

  it('refuses a document that is no longer in the space', async () => {
    missing = true;
    const result = await newResponder().answer(request(TAKE), boardState());

    expect(result).toMatchObject({ status: 'refused', reason: 'asset_missing' });
  });

  it('makes room at the budget rather than refusing, oldest hold first', async () => {
    const responder = newResponder();
    const assets: AppletAssetPin[] = [1, 2, 3].map((index) => ({
      path: `/film/shots/sh_a1b2c3d${String(index)}/take_1.mp4`,
      version: 1,
      contentHash: `f00dcafe123${String(index)}`,
    }));
    const state: Record<string, unknown> = { assets };
    const ask = (asset: AppletAssetPin) => {
      served = { sizeBytes: APPLET_MEDIA_MAX_ASSET_BYTES, contentHash: asset.contentHash };
      return responder.answer(request(asset), state);
    };

    for (const asset of assets.slice(0, 2)) {
      expect(await ask(asset)).toMatchObject({ status: 'ready' });
    }
    expect(responder.residentBytes()).toBe(APPLET_MEDIA_MAX_RESIDENT_BYTES);

    // The frame drops its own copies only once a grant lands, so a budget
    // answered with a refusal can never be relieved by the frame it refuses —
    // a long cut would walk into a permanent one. The host makes room instead.
    expect(await ask(assets[2]!)).toMatchObject({ status: 'ready' });
    expect(responder.residentBytes()).toBe(APPLET_MEDIA_MAX_RESIDENT_BYTES);

    // The evicted one is the least recently asked for, so the one still on
    // screen is not the one dropped.
    expect(await ask(assets[1]!)).toMatchObject({ status: 'ready' });

    responder.release({ type: PHOENIX_APPLET_MEDIA_RELEASE_MESSAGE_TYPE, asset: assets[1]! });
    expect(responder.residentBytes()).toBeLessThan(APPLET_MEDIA_MAX_RESIDENT_BYTES);
  });

  it('reads a document once however often the view asks for it', async () => {
    const responder = newResponder();
    await responder.answer(request(TAKE), boardState());
    await responder.answer(request(TAKE), boardState());

    expect(fetched.filter((url) => url.includes('/bytes'))).toHaveLength(1);
  });

  it('answers a malformed request rather than leaving the view waiting', async () => {
    const result = await newResponder().answer(
      { type: PHOENIX_APPLET_MEDIA_MESSAGE_TYPE, requestId: 'not-a-uuid', asset: TAKE },
      boardState(),
    );

    expect(result).toMatchObject({ status: 'refused', reason: 'invalid_request' });
  });

  it('serves the very document it refused once the gate is held open', async () => {
    gate.heldOpen = true;
    served = { ...served, contentHash: SALARIES.contentHash };
    const result = await newResponder().answer(request(SALARIES), boardState());

    expect(result).toMatchObject({ status: 'ready' });
    expect(fetched).toHaveLength(2);
  });
});
