/**
 * Which stored media types may be served inline, and what to do with the rest.
 *
 * A media type is not a description of bytes, it is an instruction to the
 * browser about how to run them. `text/html`, SVG, XHTML and XSLT-bearing XML
 * are each script-capable in their own way, and a type that arrives with the
 * content — written by an agent, a connector or a user — is chosen by whoever
 * wrote the content. Echoing it back on a response from an `aflow.ai` origin
 * turns stored bytes into same-origin script, which is the SEC-03 exploit class
 * arriving by a different road than the React render boundary that `SafeSvg`
 * guards: nothing in the DOM pipeline sees a response the browser fetched
 * directly.
 *
 * The set grows with the web platform, so what may render inline is stated as a
 * closed list and everything else is served as bytes.
 */

/**
 * Types safe to hand a browser with their own label.
 *
 * The hazard is a type the browser will parse as a document and run script
 * from — HTML, SVG, XHTML, and the XML family that reaches XSLT. Raster images,
 * audio and video are decoded by a media pipeline that has no script context,
 * so they keep their label: withholding it would strip a stored recording of
 * the one piece of metadata a player needs, and the readers that render them
 * depend on it being echoed back.
 */
const INLINE_SAFE_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/octet-stream',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
  'audio/ogg',
  'audio/aac',
  'audio/flac',
]);

/** What a refused type is downgraded to — bytes, with no rendering meaning. */
export const NEUTRALIZED_CONTENT_TYPE = 'application/octet-stream';

export interface ServableHeaders {
  contentType: string;
  /** Present only when the declared type was refused. */
  contentDisposition?: string;
}

/**
 * Resolve the headers a stored document may be served with.
 *
 * A refused type is downgraded rather than rejected: the bytes are already
 * stored and a reader asking for them is not the attacker, so failing the read
 * would punish the wrong party and hide the content from the operator trying to
 * inspect it. Downgrading keeps it retrievable and strips its authority to run.
 *
 * Parameters are stripped for the comparison only (`text/html; charset=utf-8`
 * must not slip past a set membership test) — the value returned is always one
 * of the two known-safe forms, never a reconstructed variant of the input.
 */
export function resolveServableHeaders(declared: string | null | undefined): ServableHeaders {
  const bare = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (INLINE_SAFE_TYPES.has(bare)) {
    return { contentType: bare };
  }
  return {
    contentType: NEUTRALIZED_CONTENT_TYPE,
    // Belt and braces: a browser that would otherwise sniff its way back to a
    // rendering decision is told the response is a download, not a document.
    contentDisposition: 'attachment',
  };
}

/** True when the type would have been served with its own label. */
export function isInlineSafeContentType(declared: string | null | undefined): boolean {
  const bare = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return INLINE_SAFE_TYPES.has(bare);
}
