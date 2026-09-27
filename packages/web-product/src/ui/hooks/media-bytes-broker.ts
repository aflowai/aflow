'use client';

/**
 * How a card addresses the bytes of a generated asset.
 *
 * An asset is a memory document behind an authenticated read, and its readers
 * want different things from it. A clip on a card must stay on the wire: the
 * element loads `docBytesUrl` and issues its own ranged requests, so the
 * document's size stops deciding what a card costs to show. A still is small
 * and every card that shows it wants the same bytes, so it is fetched once
 * through `acquireDocBytes` and shared as an object URL — which pins the Blob
 * in memory until the last card holding it releases. An applet frame can use
 * neither: it cannot fetch, and an object URL minted here belongs to this
 * origin, which the sandboxed frame cannot address. It takes the Blob itself
 * through `acquireDocBlob` and mints its own URL on the far side.
 */

/** Matches the event brokers: a remount reuses the Blob instead of refetching it. */
const REVOKE_GRACE_MS = 250;

/**
 * The URL a media element loads a document from.
 *
 * The element does the transfer itself, so the route's `Range` / `If-Range`
 * handling decides how many bytes cross the wire — `preload="metadata"` costs a
 * header block rather than a whole render, and a seek costs the span it lands
 * on. The space rides in the query string because a `<video src>` carries no
 * headers; the server resolves it from there exactly as it resolves the header,
 * and still answers only for a space the caller is a member of.
 */
export function docBytesUrl(apiUrl: string, spaceId: string, docId: string): string {
  return `${apiUrl}/memory/docs/${docId}/bytes?spaceId=${encodeURIComponent(spaceId)}`;
}

/** One document's bytes, as the read answered them. */
export interface DocBytes {
  blob: Blob;
  /** The hash the read served the bytes under, when it carried an ETag. */
  contentHash: string | null;
  mimeType: string;
}

interface DocBytesEntry {
  bytes: Promise<DocBytes>;
  /** Minted only for the readers that want a URL — a Blob reader never needs one. */
  objectUrl: Promise<string> | null;
  refCount: number;
  revokeTimer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, DocBytesEntry>();

/**
 * The bytes are served against the caller's tenant and space, so a document id
 * on its own is not the identity of what was fetched: keyed by id alone, a
 * space switch would be answered from the Blob the previous space read. A
 * reader that knows which bytes it expects keys on those too, so a document
 * rewritten in place is read again rather than answered from the old ones.
 */
function docBytesKey(
  requestHeaders: Record<string, string>,
  docId: string,
  expectedContentHash: string | undefined,
): string {
  return `${requestHeaders['X-Tenant-ID'] ?? ''}/${requestHeaders['X-Space-ID'] ?? ''}/${docId}/${expectedContentHash ?? ''}`;
}

/** `"<hash>"` / `W/"<hash>"` → `<hash>`. */
function parseETag(etag: string | null): string | null {
  if (etag === null) return null;
  const match = /^(?:W\/)?"(.*)"$/.exec(etag.trim());
  return match?.[1] ?? etag.trim();
}

function createEntry(
  key: string,
  apiUrl: string,
  requestHeaders: Record<string, string>,
  docId: string,
): DocBytesEntry {
  const bytes = fetch(`${apiUrl}/memory/docs/${docId}/bytes`, {
    headers: requestHeaders,
  }).then(async (res): Promise<DocBytes> => {
    if (!res.ok) throw new Error(`Failed to load media: ${String(res.status)}`);
    const blob = await res.blob();
    return {
      blob,
      contentHash: parseETag(res.headers.get('ETag')),
      mimeType: res.headers.get('Content-Type') ?? blob.type,
    };
  });
  const entry: DocBytesEntry = { bytes, objectUrl: null, refCount: 0, revokeTimer: null };
  entries.set(key, entry);
  // A cached rejection would keep answering with a failure that has since
  // passed — a token that had not loaded yet, a space id that arrived after
  // the first paint.
  void bytes.catch(() => {
    if (entries.get(key) === entry) entries.delete(key);
  });
  return entry;
}

interface HeldEntry {
  entry: DocBytesEntry;
  release: () => void;
}

function acquire(
  apiUrl: string,
  requestHeaders: Record<string, string>,
  docId: string,
  expectedContentHash?: string,
): HeldEntry {
  const key = docBytesKey(requestHeaders, docId, expectedContentHash);
  const entry = entries.get(key) ?? createEntry(key, apiUrl, requestHeaders, docId);
  if (entry.revokeTimer) {
    clearTimeout(entry.revokeTimer);
    entry.revokeTimer = null;
  }
  entry.refCount += 1;

  let released = false;
  return {
    entry,
    release: () => {
      if (released) return;
      released = true;
      entry.refCount -= 1;
      if (entry.refCount > 0) return;
      if (entry.revokeTimer) clearTimeout(entry.revokeTimer);
      entry.revokeTimer = setTimeout(() => {
        if (entry.refCount > 0) return;
        // A failed fetch already dropped its own key, and a later acquire may
        // have filed a fresh entry under it — only this one's is ours to drop.
        if (entries.get(key) === entry) entries.delete(key);
        const objectUrl = entry.objectUrl;
        if (objectUrl === null) return;
        void objectUrl.then(
          (url) => {
            URL.revokeObjectURL(url);
          },
          () => undefined,
        );
      }, REVOKE_GRACE_MS);
    },
  };
}

export interface HeldDocBytes {
  objectUrl: Promise<string>;
  release: () => void;
}

/**
 * Take a reference to a document's bytes as a URL this origin can load. Every
 * acquire is paired with exactly one `release`; the Blob is revoked once the
 * count reaches zero and stays there for the grace period, so a remount reads
 * what is already in memory.
 */
export function acquireDocBytes(
  apiUrl: string,
  requestHeaders: Record<string, string>,
  docId: string,
): HeldDocBytes {
  const held = acquire(apiUrl, requestHeaders, docId);
  held.entry.objectUrl ??= held.entry.bytes.then((bytes) => URL.createObjectURL(bytes.blob));
  return { objectUrl: held.entry.objectUrl, release: held.release };
}

export interface HeldDocBlob {
  bytes: Promise<DocBytes>;
  release: () => void;
}

/**
 * Take a reference to a document's bytes as the Blob itself, for a reader that
 * cannot use an object URL minted by this origin. `expectedContentHash` is the
 * bytes the caller was promised: it keys the entry, so a document rewritten
 * under the same id is read again rather than answered from the old Blob.
 */
export function acquireDocBlob(
  apiUrl: string,
  requestHeaders: Record<string, string>,
  docId: string,
  expectedContentHash?: string,
): HeldDocBlob {
  const held = acquire(apiUrl, requestHeaders, docId, expectedContentHash);
  return { bytes: held.entry.bytes, release: held.release };
}

/** Documents whose bytes are still pinned in memory. */
export function heldDocCount(): number {
  return entries.size;
}

export function __resetForTests(): void {
  for (const entry of entries.values()) {
    if (entry.revokeTimer) clearTimeout(entry.revokeTimer);
  }
  entries.clear();
}
