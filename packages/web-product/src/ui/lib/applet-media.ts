'use client';

/**
 * The host half of the applet media channel: the only place a view's request
 * for bytes is turned into a read.
 *
 * The gate lives here rather than in the component because this is the single
 * function that both decides and reads. Nothing exported takes a document id or
 * a path, so there is no entry point that skips the decision, and the permitted
 * set is derived from the state handed in on every call rather than stored —
 * a set kept between calls is a set a later caller can widen or stale.
 */
import {
  APPLET_MEDIA_MAX_ASSET_BYTES,
  APPLET_MEDIA_MAX_RESIDENT_BYTES,
  APPLET_MEDIA_MESSAGE_MAX_LENGTH,
  PHOENIX_APPLET_MEDIA_RESULT_MESSAGE_TYPE,
  PhoenixAppletMediaMessageSchema,
  PhoenixAppletMediaReleaseMessageSchema,
  appletAssetPinKey,
  type AppletAssetPin,
  type AppletMediaRefusalReason,
  type PhoenixAppletMediaResultMessage,
} from '@aflow/schemas';
import { appletStateReferencesAsset } from '@aflow/applet-runtime';
import { acquireDocBlob, type DocBytes, type HeldDocBlob } from '../hooks/media-bytes-broker.js';

export interface AppletMediaResponderOptions {
  apiUrl: string;
  headers: () => Record<string, string>;
}

export interface AppletMediaResponder {
  /**
   * Answer one `phoenix:media` request against the authoritative state the
   * platform holds for this instance. Null when the message carries no request
   * id to answer — there is no promise waiting on the other side.
   */
  answer(
    message: unknown,
    state: Record<string, unknown> | undefined,
  ): Promise<PhoenixAppletMediaResultMessage | null>;
  /** Honour a `phoenix:media-release` — the frame dropped its copy. */
  release(message: unknown): void;
  /** Drop every hold: the frame reloaded or unmounted, so its copies are gone. */
  reset(): void;
  /** Bytes this instance currently holds — the budget the next request is measured against. */
  residentBytes(): number;
}

interface ResolvedDoc {
  docId: string;
  sizeBytes: number;
}

interface Hold {
  held: HeldDocBlob;
  sizeBytes: number;
  /** Ordering for eviction — the least recently asked-for goes first. */
  usedAt: number;
}

export function createAppletMediaResponder(
  options: AppletMediaResponderOptions,
): AppletMediaResponder {
  const holds = new Map<string, Hold>();
  const resolved = new Map<string, ResolvedDoc>();
  let residentBytes = 0;
  let clock = 0;

  /** Drop least-recently-asked-for holds until `wanted` more bytes would fit. */
  function evictUntilRoomFor(wanted: number): void {
    while (residentBytes + wanted > APPLET_MEDIA_MAX_RESIDENT_BYTES && holds.size > 0) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [key, hold] of holds) {
        if (hold.usedAt < oldest) {
          oldest = hold.usedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      const hold = holds.get(oldestKey);
      if (hold === undefined) return;
      holds.delete(oldestKey);
      residentBytes -= hold.sizeBytes;
      hold.held.release();
    }
  }
  // One asset is buffered at a time: the host reads a whole document (a prefix
  // of an MP4 is not a playable file) and a view that asks for a timeline at
  // once would otherwise hold all of them in this heap simultaneously.
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function resolveDoc(path: string): Promise<ResolvedDoc | null> {
    const cached = resolved.get(path);
    if (cached) return cached;
    const params = new URLSearchParams({
      pathPrefix: path,
      mode: 'list',
      recursive: 'true',
      // `_` is a single-character wildcard to SQL LIKE, and the prefix is not
      // escaped before it becomes one — so `take_2.mp4` also matches
      // `take-2.mp4`, which sorts first. Asking for one row therefore answers
      // with a sibling and the exact-match check below reads a pinned document
      // as missing. Take a page and find the one actually asked for.
      limit: '50',
    });
    const res = await fetch(`${options.apiUrl}/memory/docs?${params.toString()}`, {
      headers: options.headers(),
    });
    if (!res.ok) throw new Error(`The document read answered HTTP ${String(res.status)}.`);
    const item = exactItem(await res.json(), path);
    if (item === null) return null;
    const doc: ResolvedDoc = { docId: item.id, sizeBytes: item.sizeBytes };
    resolved.set(path, doc);
    return doc;
  }

  async function serve(
    requestId: string,
    asset: AppletAssetPin,
  ): Promise<PhoenixAppletMediaResultMessage> {
    const key = appletAssetPinKey(asset);
    const existing = holds.get(key);
    if (existing) {
      existing.usedAt = ++clock;
      const bytes = await existing.held.bytes;
      return ready(requestId, bytes.blob, bytes.mimeType);
    }

    let doc: ResolvedDoc | null;
    try {
      doc = await resolveDoc(asset.path);
    } catch (err) {
      return refuse(requestId, 'request_failed', errorText(err));
    }
    if (doc === null) {
      return refuse(requestId, 'asset_missing', `This space holds no document at ${asset.path}.`);
    }
    if (doc.sizeBytes > APPLET_MEDIA_MAX_ASSET_BYTES) {
      return refuse(requestId, 'too_large', tooLargeMessage(asset.path, doc.sizeBytes));
    }
    // Make room rather than refuse. The frame drops its own copies as it goes,
    // but that only runs once a grant has landed — so a budget answered with a
    // refusal can never be relieved by the frame it is refusing, and a long cut
    // walks into a permanent one. Dropping a hold here releases this reader's
    // claim on the bytes; a frame still showing an earlier clip keeps its own
    // copy, because what crossed to it was a clone it minted its URL from.
    evictUntilRoomFor(doc.sizeBytes);
    if (residentBytes + doc.sizeBytes > APPLET_MEDIA_MAX_RESIDENT_BYTES) {
      return refuse(requestId, 'budget_exhausted', budgetMessage());
    }

    const held = acquireDocBlob(options.apiUrl, options.headers(), doc.docId, asset.contentHash);
    let bytes: DocBytes;
    try {
      bytes = await held.bytes;
    } catch (err) {
      held.release();
      return refuse(requestId, 'request_failed', errorText(err));
    }
    if (bytes.contentHash !== asset.contentHash) {
      held.release();
      return refuse(requestId, 'asset_changed', changedMessage(asset.path, bytes.contentHash));
    }
    // The recorded size gates the transfer; the retrieved length decides.
    if (bytes.blob.size > APPLET_MEDIA_MAX_ASSET_BYTES) {
      held.release();
      return refuse(requestId, 'too_large', tooLargeMessage(asset.path, bytes.blob.size));
    }

    holds.set(key, { held, sizeBytes: bytes.blob.size, usedAt: ++clock });
    residentBytes += bytes.blob.size;
    return ready(requestId, bytes.blob, bytes.mimeType);
  }

  return {
    async answer(message, state) {
      const parsed = PhoenixAppletMediaMessageSchema.safeParse(message);
      if (!parsed.success) {
        const requestId = (message as { requestId?: unknown } | null)?.requestId;
        if (typeof requestId !== 'string') return null;
        return refuse(
          requestId,
          'invalid_request',
          'The media request does not name an asset the way a pinned reference is written.',
        );
      }
      const { requestId, asset } = parsed.data;

      // The permitted set is derived here, from the authoritative state, on
      // every request. Never from the optimistic overlay: a patch the view
      // proposed is the view's own writing, so deriving from it would let a
      // view name any document and then read it.
      if (state === undefined || !appletStateReferencesAsset(state, asset)) {
        return refuse(requestId, 'not_referenced', notReferencedMessage(asset));
      }

      return enqueue(() => serve(requestId, asset));
    },

    release(message) {
      const parsed = PhoenixAppletMediaReleaseMessageSchema.safeParse(message);
      if (!parsed.success) return;
      const key = appletAssetPinKey(parsed.data.asset);
      const hold = holds.get(key);
      if (!hold) return;
      holds.delete(key);
      residentBytes -= hold.sizeBytes;
      hold.held.release();
    },

    reset() {
      for (const hold of holds.values()) hold.held.release();
      holds.clear();
      resolved.clear();
      residentBytes = 0;
    },

    residentBytes() {
      return residentBytes;
    },
  };
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

function ready(requestId: string, blob: Blob, mimeType: string): PhoenixAppletMediaResultMessage {
  return {
    type: PHOENIX_APPLET_MEDIA_RESULT_MESSAGE_TYPE,
    requestId,
    status: 'ready',
    blob,
    mimeType,
    sizeBytes: blob.size,
  };
}

function refuse(
  requestId: string,
  reason: AppletMediaRefusalReason,
  message: string,
): PhoenixAppletMediaResultMessage {
  return {
    type: PHOENIX_APPLET_MEDIA_RESULT_MESSAGE_TYPE,
    requestId,
    status: 'refused',
    reason,
    message: message.slice(0, APPLET_MEDIA_MESSAGE_MAX_LENGTH),
  };
}

function notReferencedMessage(asset: AppletAssetPin): string {
  return (
    `Nothing this board holds points at ${asset.path} version ${String(asset.version)}. ` +
    'An applet shows the assets its own state pins, and this is not one of them.'
  );
}

function changedMessage(path: string, served: string | null): string {
  return served === null
    ? `The platform cannot confirm that the bytes at ${path} are the ones this board pinned.`
    : `The document at ${path} has been rewritten since this board pinned it. Pin it again to show it.`;
}

function tooLargeMessage(path: string, sizeBytes: number): string {
  return (
    `${path} is ${megabytes(sizeBytes)} MB, past the ${megabytes(APPLET_MEDIA_MAX_ASSET_BYTES)} MB ` +
    'an applet may hold. Open it in the knowledge viewer, which streams it instead.'
  );
}

function budgetMessage(): string {
  return (
    `This applet already holds its ${megabytes(APPLET_MEDIA_MAX_RESIDENT_BYTES)} MB of media. ` +
    'It shows fewer assets at once, or releases the ones it has stopped showing.'
  );
}

function megabytes(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'The read never reached the platform.';
}

// ---------------------------------------------------------------------------
// Response narrowing
// ---------------------------------------------------------------------------

interface ListedDoc {
  id: string;
  path: string;
  sizeBytes: number;
}

/** The listed document at exactly `wanted`, or null — a prefix match is not one. */
function exactItem(body: unknown, wanted: string): ListedDoc | null {
  if (typeof body !== 'object' || body === null) return null;
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  for (const candidate of items) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const { id, path, sizeBytes } = candidate as Record<string, unknown>;
    if (typeof id !== 'string' || typeof path !== 'string' || typeof sizeBytes !== 'number') {
      continue;
    }
    if (path === wanted) return { id, path, sizeBytes };
  }
  return null;
}
