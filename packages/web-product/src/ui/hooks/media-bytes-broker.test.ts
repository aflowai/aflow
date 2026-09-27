import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  __resetForTests,
  acquireDocBlob,
  acquireDocBytes,
  heldDocCount,
} from './media-bytes-broker';

const REVOKE_GRACE_MS = 250;
const API = 'http://api.test';
const DOC = 'doc-01JB0000000000000000000001';

function headers(spaceId: string): Record<string, string> {
  return { 'X-Tenant-ID': 'tenant-a', 'X-Space-ID': spaceId, Authorization: 'Bearer t' };
}

let created: string[];
let revoked: string[];
let fetched: Array<{ url: string; headers: Record<string, string> }>;
let respond: (url: string) => Promise<Response>;

function ok(): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    blob: () => Promise.resolve(new Blob(['x'])),
    headers: new Headers({ ETag: '"hash-1"', 'Content-Type': 'image/png' }),
  } as unknown as Response);
}

beforeEach(() => {
  vi.useFakeTimers();
  created = [];
  revoked = [];
  fetched = [];
  respond = ok;
  let next = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    next += 1;
    const url = `blob:media-${String(next)}`;
    created.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    revoked.push(url);
  });
  vi.stubGlobal('fetch', (url: string, init: { headers: Record<string, string> }) => {
    fetched.push({ url, headers: init.headers });
    return respond(url);
  });
});

afterEach(() => {
  __resetForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('media bytes broker', () => {
  it('fetches one document once however many cards show it', async () => {
    const first = acquireDocBytes(API, headers('space-A'), DOC);
    const second = acquireDocBytes(API, headers('space-A'), DOC);

    expect(await first.objectUrl).toBe(await second.objectUrl);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.url).toBe(`${API}/memory/docs/${DOC}/bytes`);
    expect(created).toHaveLength(1);
  });

  it('holds the bytes until the last card releases, then revokes them', async () => {
    const first = acquireDocBytes(API, headers('space-A'), DOC);
    const second = acquireDocBytes(API, headers('space-A'), DOC);
    const url = await first.objectUrl;

    first.release();
    await vi.advanceTimersByTimeAsync(REVOKE_GRACE_MS * 4);
    expect(revoked).toEqual([]);
    expect(heldDocCount()).toBe(1);

    second.release();
    await vi.advanceTimersByTimeAsync(REVOKE_GRACE_MS * 2);
    expect(revoked).toEqual([url]);
    expect(heldDocCount()).toBe(0);
  });

  it('re-uses the Blob when a card remounts inside the grace window', async () => {
    const first = acquireDocBytes(API, headers('space-A'), DOC);
    const url = await first.objectUrl;
    first.release();

    await vi.advanceTimersByTimeAsync(REVOKE_GRACE_MS / 2);
    const remounted = acquireDocBytes(API, headers('space-A'), DOC);
    await vi.advanceTimersByTimeAsync(REVOKE_GRACE_MS * 4);

    expect(await remounted.objectUrl).toBe(url);
    expect(fetched).toHaveLength(1);
    expect(revoked).toEqual([]);
  });

  it('releases a clip whose only card unmounted while the fetch was still running', async () => {
    let deliver: (() => void) | undefined;
    respond = () =>
      new Promise<Response>((resolve) => {
        deliver = () => {
          resolve(ok());
        };
      });

    const held = acquireDocBytes(API, headers('space-A'), DOC);
    held.release();
    deliver?.();
    await vi.advanceTimersByTimeAsync(REVOKE_GRACE_MS * 2);
    await held.objectUrl;
    await vi.advanceTimersByTimeAsync(REVOKE_GRACE_MS * 2);

    expect(created).toHaveLength(1);
    expect(revoked).toEqual(created);
    expect(heldDocCount()).toBe(0);
  });

  it('never serves one space the bytes another space was authorized for', async () => {
    const inA = acquireDocBytes(API, headers('space-A'), DOC);
    const inB = acquireDocBytes(API, headers('space-B'), DOC);

    expect(await inA.objectUrl).not.toBe(await inB.objectUrl);
    expect(fetched).toHaveLength(2);
    expect(fetched.map((call) => call.headers['X-Space-ID'])).toEqual(['space-A', 'space-B']);
    expect(heldDocCount()).toBe(2);
  });

  it('does not cache a failure past the card that saw it', async () => {
    respond = () => Promise.resolve({ ok: false, status: 401 } as unknown as Response);
    const failed = acquireDocBytes(API, headers('space-A'), DOC);
    await expect(failed.objectUrl).rejects.toThrow('401');
    failed.release();

    respond = ok;
    const retried = acquireDocBytes(API, headers('space-A'), DOC);
    expect(await retried.objectUrl).toBe(created[0]);
    expect(fetched).toHaveLength(2);
  });

  it('hands over the Blob itself, and mints no url for a reader that cannot use one', async () => {
    const held = acquireDocBlob(API, headers('space-A'), DOC, 'hash-1');
    const bytes = await held.bytes;

    expect(bytes.contentHash).toBe('hash-1');
    expect(bytes.mimeType).toBe('image/png');
    expect(created).toEqual([]);
    expect(fetched).toHaveLength(1);
  });

  it('reads again when the bytes a caller expects are not the ones it holds', async () => {
    const first = acquireDocBlob(API, headers('space-A'), DOC, 'hash-1');
    const second = acquireDocBlob(API, headers('space-A'), DOC, 'hash-2');
    await Promise.all([first.bytes, second.bytes]);

    expect(fetched).toHaveLength(2);
    expect(heldDocCount()).toBe(2);
  });

  it('leaves a live entry alone when a stale release times out', async () => {
    respond = () => Promise.resolve({ ok: false, status: 401 } as unknown as Response);
    const failed = acquireDocBytes(API, headers('space-A'), DOC);
    await expect(failed.objectUrl).rejects.toThrow('401');

    respond = ok;
    const retried = acquireDocBytes(API, headers('space-A'), DOC);
    const url = await retried.objectUrl;
    failed.release();
    await vi.advanceTimersByTimeAsync(REVOKE_GRACE_MS * 4);

    expect(revoked).toEqual([]);
    expect(heldDocCount()).toBe(1);
    expect(await acquireDocBytes(API, headers('space-A'), DOC).objectUrl).toBe(url);
    expect(fetched).toHaveLength(2);
  });
});
