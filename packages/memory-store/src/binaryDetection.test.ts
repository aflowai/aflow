/**
 * The extension half of the lane decision. Every case here holds bytes that
 * decode as UTF-8 on purpose: the sniff alone calls them text, so only the
 * extension can keep them off the text lane.
 */
import { describe, it, expect } from 'vitest';
import { bytesAreUtf8, hasBinaryExtension, isBinaryContent } from './binaryDetection.js';

/** Short enough to be plausible as a clip fragment, and valid UTF-8. */
const DECODABLE = Buffer.from('ftypisom moov mdat', 'utf8');

const MEDIA_CONTAINERS = [
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mkv',
  'avi',
  'mp3',
  'm4a',
  'wav',
  'flac',
  'ogg',
  'aac',
];

describe('isBinaryContent — media containers', () => {
  it('holds bytes the sniff alone would call text', () => {
    expect(bytesAreUtf8(DECODABLE)).toBe(true);
    expect(isBinaryContent(DECODABLE, '/downloads/notes.txt')).toBe(false);
  });

  it.each(MEDIA_CONTAINERS)('routes .%s to the binary lane on its extension', (extension) => {
    const path = `/downloads/clip.${extension}`;
    expect(hasBinaryExtension(path)).toBe(true);
    expect(isBinaryContent(DECODABLE, path)).toBe(true);
    expect(isBinaryContent(DECODABLE, path.toUpperCase())).toBe(true);
  });

  it('routes undecodable bytes to the binary lane whatever the path says', () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    expect(bytesAreUtf8(png)).toBe(false);
    expect(isBinaryContent(png, '/downloads/clip.txt')).toBe(true);
  });
});
