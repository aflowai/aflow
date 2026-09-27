import { createHash } from 'node:crypto';

export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Hash for binary-lane content — sha256 over the exact bytes. */
export function computeBytesHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function makePreview(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '...';
}
