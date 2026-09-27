/**
 * The media channel — how a view obtains the bytes of an asset its own state
 * pins. The iframe cannot fetch (`connect-src 'none'`) and cannot address a
 * `blob:` URL minted by the embedding page (its origin is opaque), so the host
 * reads the document and hands the Blob across the postMessage boundary; the
 * frame mints its own object URL, which `media-src blob:` already admits.
 *
 * The request names an asset, never a document id: what the host will read is
 * decided by the instance's state, and a state carries pins.
 */
import { z } from 'zod';

export const PHOENIX_APPLET_MEDIA_MESSAGE_TYPE = 'phoenix:media';
export const PHOENIX_APPLET_MEDIA_RESULT_MESSAGE_TYPE = 'phoenix:media-result';
export const PHOENIX_APPLET_MEDIA_RELEASE_MESSAGE_TYPE = 'phoenix:media-release';

// ============================================================================
// The asset pin
// ============================================================================

/**
 * An asset as a state pins it: the memory path plus the exact bytes it was
 * pinned to. `version` and `contentHash` are required and there is no shape
 * that omits them — a reference naming only a path proves nothing about what
 * comes back, and the host serves an asset only when the served bytes are the
 * ones the state named.
 */
export const AppletAssetPinSchema = z.object({
  path: z
    .string()
    .min(2)
    .max(512)
    .regex(/^\/[A-Za-z0-9._/-]{1,500}$/),
  version: z.number().int().positive(),
  contentHash: z.string().min(8).max(128),
});
export type AppletAssetPin = z.infer<typeof AppletAssetPinSchema>;

/** Identity of one pinned asset — the key the permitted set and the host's ledger share. */
export function appletAssetPinKey(pin: AppletAssetPin): string {
  return `${pin.path}@${String(pin.version)}#${pin.contentHash}`;
}

// ============================================================================
// Caps
// ============================================================================

/**
 * The largest single asset the host will hand a frame. Past this the asset is
 * watched through the space's own viewer, which streams it by range against
 * the same route — a frame has no ranged read, so its copy is whole or absent.
 */
export const APPLET_MEDIA_MAX_ASSET_BYTES = 33_554_432;

/**
 * What one instance may hold in the tab at once. A timeline of forty-five
 * clips is past any budget a browser tab has, so the view asks for what it is
 * showing and the bytes it stops showing are released; a view that releases
 * nothing is refused at this line rather than growing without bound.
 */
export const APPLET_MEDIA_MAX_RESIDENT_BYTES = 67_108_864;

// ============================================================================
// Wire messages
// ============================================================================

/** Iframe → host: serve the bytes of one pinned asset. */
export const PhoenixAppletMediaMessageSchema = z.object({
  type: z.literal(PHOENIX_APPLET_MEDIA_MESSAGE_TYPE),
  requestId: z.string().uuid(),
  asset: AppletAssetPinSchema,
});
export type PhoenixAppletMediaMessage = z.infer<typeof PhoenixAppletMediaMessageSchema>;

/** Iframe → host: this asset is no longer on screen — drop the hold on its bytes. */
export const PhoenixAppletMediaReleaseMessageSchema = z.object({
  type: z.literal(PHOENIX_APPLET_MEDIA_RELEASE_MESSAGE_TYPE),
  asset: AppletAssetPinSchema,
});
export type PhoenixAppletMediaReleaseMessage = z.infer<
  typeof PhoenixAppletMediaReleaseMessageSchema
>;

/**
 * Why the host would not serve an asset. `not_referenced` is the one that
 * carries the rule: the permitted set is whatever the instance's own state
 * pins, so a request for anything else is answered by this and never by bytes.
 */
export const AppletMediaRefusalReasonSchema = z.enum([
  'invalid_request',
  'not_referenced',
  'asset_missing',
  'asset_changed',
  'too_large',
  'budget_exhausted',
  'request_failed',
  'unsupported',
]);
export type AppletMediaRefusalReason = z.infer<typeof AppletMediaRefusalReasonSchema>;

/** Maximum length of the sentence a refusal shows the person. */
export const APPLET_MEDIA_MESSAGE_MAX_LENGTH = 500;

/**
 * Host → iframe: the bytes, or why not. Declared as a type rather than a
 * schema because it carries a Blob — the host is its only writer, and a
 * validator over a platform object buys nothing the type does not.
 */
export interface PhoenixAppletMediaResultMessage {
  type: typeof PHOENIX_APPLET_MEDIA_RESULT_MESSAGE_TYPE;
  requestId: string;
  status: 'ready' | 'refused';
  /** Present when ready — structured-cloned; the frame mints its own object URL. */
  blob?: Blob;
  mimeType?: string;
  sizeBytes?: number;
  reason?: AppletMediaRefusalReason;
  /** Present on a refusal — the whole teaching surface the view can show. */
  message?: string;
}
