import { BROWSER_APPROVAL_PATH_MAX_UNITS } from './requestedInput.js';

/** The longest path segment an approver is shown as it is, in UTF-16 units. */
export const BROWSER_APPROVAL_SEGMENT_MAX_UNITS = 48;

/** What an approver is shown in place of a segment that may be a credential. */
export const BROWSER_APPROVAL_HIDDEN_SEGMENT = '[hidden]';

/** The shortest run of characters read as an identifier rather than a word or a number. */
const OPAQUE_RUN = 16;
const HEX_RUN = /^[0-9a-f]{16,}$/i;

function opaque(segment: string): boolean {
  if (segment.length > BROWSER_APPROVAL_SEGMENT_MAX_UNITS) return true;
  if (HEX_RUN.test(segment.replace(/-/g, ''))) return true;
  return segment
    .split(/[-_.~]/)
    .some(
      (part) =>
        part.length >= OPAQUE_RUN &&
        ((/[A-Za-z]/.test(part) && /\d/.test(part)) || (/[a-z]/.test(part) && /[A-Z]/.test(part))),
    );
}

/**
 * The part of a page's address an approver is shown beside its origin. The
 * address binds the approval whole, through the request hash; this is only
 * what the Action Center item shows, and the item reaches every resolver in
 * the space. A path can hold an identifier that works as a credential (a
 * reset link, a signed share), so for http(s) each segment longer than
 * `BROWSER_APPROVAL_SEGMENT_MAX_UNITS`, or that reads as hex or base64 rather
 * than words and numbers, is shown as `BROWSER_APPROVAL_HIDDEN_SEGMENT`, and
 * the query and fragment are not shown. A `data:` or `blob:` address's path is
 * its content, so any other scheme is shown by its scheme alone.
 */
export function browserApprovalShownPath(address: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return url.protocol;
  return url.pathname
    .split('/')
    .map((segment) => (opaque(segment) ? BROWSER_APPROVAL_HIDDEN_SEGMENT : segment))
    .join('/')
    .slice(0, BROWSER_APPROVAL_PATH_MAX_UNITS);
}
