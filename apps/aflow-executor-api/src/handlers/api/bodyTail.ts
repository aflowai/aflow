/**
 * The end of a response body, read without holding the body: the stream is
 * read through and only its last `windowBytes` are kept, so a body larger than
 * the inline budget still yields its end.
 */
import { apiError } from '../../lib/api-errors.js';
import { ApiExecutionError } from './types.js';

/** What a tail read passed over before the bytes it kept. */
export interface SkippedPrefix {
  bytes: number;
  lineBreaks: number;
  /** Whether the last byte passed over was a line break, so the kept text starts a line. */
  endsLine: boolean;
}

export const NOTHING_SKIPPED: SkippedPrefix = { bytes: 0, lineBreaks: 0, endsLine: true };

export interface BodyTail {
  text: string;
  skipped: SkippedPrefix;
}

const LINE_FEED = 0x0a;

function countLineBreaks(bytes: Uint8Array): number {
  let n = 0;
  for (let i = bytes.indexOf(LINE_FEED); i !== -1; i = bytes.indexOf(LINE_FEED, i + 1)) n++;
  return n;
}

function tooLarge(message: string, details: Record<string, unknown>): ApiExecutionError {
  return new ApiExecutionError(
    apiError('API_RESPONSE_TOO_LARGE', message, { retryable: false, details }),
  );
}

/**
 * Reads `response` to its end, keeping its last `windowBytes`. `maxBytes`
 * bounds what is streamed, not what is held: the fetch timeout is cleared
 * before the body is read, so a body that never ends needs a ceiling.
 *
 * The body is read as fetch delivers it, already decoded: undici decodes the
 * Content-Encodings it names (gzip, deflate, br) while it streams.
 */
export async function readBodyTail(
  response: Response,
  windowBytes: number,
  maxBytes: number,
): Promise<BodyTail> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw tooLarge(
      `Response Content-Length ${contentLength} exceeds budget of ${String(maxBytes)} bytes`,
      { contentLength, maxBytes },
    );
  }

  const skipped: SkippedPrefix = { ...NOTHING_SKIPPED };
  const pass = (bytes: Uint8Array): void => {
    if (bytes.byteLength === 0) return;
    skipped.bytes += bytes.byteLength;
    skipped.lineBreaks += countLineBreaks(bytes);
    skipped.endsLine = bytes[bytes.byteLength - 1] === LINE_FEED;
  };

  const held: Uint8Array[] = [];
  let start = 0;
  let heldBytes = 0;
  let readBytes = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      readBytes += value.byteLength;
      if (readBytes > maxBytes) {
        await reader.cancel();
        throw tooLarge(
          `Response body exceeded budget of ${String(maxBytes)} bytes (read ${String(readBytes)})`,
          { readBytes, maxBytes },
        );
      }
      held.push(value);
      heldBytes += value.byteLength;
      // Whole chunks go while what remains still fills the window; the list is
      // compacted only once half of it is gone, so tiny chunks stay linear.
      for (
        let first = held[start];
        first !== undefined && heldBytes - first.byteLength >= windowBytes;
        first = held[start]
      ) {
        start++;
        heldBytes -= first.byteLength;
        pass(first);
      }
      if (start > held.length / 2) {
        held.splice(0, start);
        start = 0;
      }
    }
  }

  const all = Buffer.concat(held.slice(start), heldBytes);
  const excess = Math.max(0, all.byteLength - windowBytes);
  pass(all.subarray(0, excess));
  return { text: new TextDecoder().decode(all.subarray(excess)), skipped };
}
