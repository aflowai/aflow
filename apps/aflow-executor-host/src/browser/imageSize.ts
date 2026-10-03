/**
 * The pixel size of a PNG or JPEG, read from its own header.
 *
 * The browser is not asked: what it reports is in CSS pixels, and the image it
 * stores is scaled by the display's density, so only the bytes say what was
 * stored.
 */

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(bytes: Buffer): ImageSize | undefined {
  // The signature, then IHDR: length, type, width, height.
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Start-of-frame markers, which carry the frame's size; every other segment is skipped. */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1] ?? 0;
    if (isStartOfFrame(marker)) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return undefined;
}

export function imageSize(bytes: Buffer, contentType: 'image/png' | 'image/jpeg'): ImageSize {
  const size = contentType === 'image/png' ? pngSize(bytes) : jpegSize(bytes);
  if (size === undefined || size.width === 0 || size.height === 0) {
    throw new Error(`The browser returned an image that is not a readable ${contentType}.`);
  }
  return size;
}
