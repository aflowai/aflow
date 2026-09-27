/**
 * What a delivered render actually is, read from the file itself.
 *
 * No image or video route reports the dimensions or the length it produced, and
 * the request is not an answer: a route that clamps a 12s ask to 8s still bills
 * and delivers 8. The container states what it holds, so the bytes are the only
 * honest source — and they are already in hand at delivery.
 *
 * Every reader is bounds-checked and every unrecognised container yields an
 * empty format: a receipt that says nothing is recoverable, one that says the
 * wrong thing is not.
 */
import type { MediaAssetKind, MediaRenderedFormat } from '@aflow/schemas';

interface Dimensions {
  width: number;
  height: number;
}

function dimensions(width: number, height: number): Dimensions | undefined {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    ? { width, height }
    : undefined;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function probePng(bytes: Buffer): Dimensions | undefined {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return undefined;
  return dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

function probeGif(bytes: Buffer): Dimensions | undefined {
  if (bytes.length < 10) return undefined;
  const header = bytes.subarray(0, 6).toString('latin1');
  if (header !== 'GIF87a' && header !== 'GIF89a') return undefined;
  return dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
}

/** Frame-describing markers; every other one carries a length this can skip. */
const JPEG_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function probeJpeg(bytes: Buffer): Dimensions | undefined {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    if (marker === undefined) return undefined;
    // Standalone markers carry no length segment to step over.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (segmentLength < 2) return undefined;
    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (offset + 9 > bytes.length) return undefined;
      return dimensions(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
    }
    offset += 2 + segmentLength;
  }
  return undefined;
}

function probeWebp(bytes: Buffer): Dimensions | undefined {
  if (bytes.length < 30) return undefined;
  if (bytes.subarray(0, 4).toString('latin1') !== 'RIFF') return undefined;
  if (bytes.subarray(8, 12).toString('latin1') !== 'WEBP') return undefined;
  const chunk = bytes.subarray(12, 16).toString('latin1');
  const data = 20;
  if (chunk === 'VP8X') {
    return dimensions(bytes.readUIntLE(data + 4, 3) + 1, bytes.readUIntLE(data + 7, 3) + 1);
  }
  if (chunk === 'VP8 ') {
    if (bytes.readUIntBE(data + 3, 3) !== 0x9d012a) return undefined;
    return dimensions(bytes.readUInt16LE(data + 6) & 0x3fff, bytes.readUInt16LE(data + 8) & 0x3fff);
  }
  if (chunk === 'VP8L') {
    if (bytes[data] !== 0x2f) return undefined;
    const bits = bytes.readUInt32LE(data + 1);
    return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return undefined;
}

interface Box {
  type: string;
  start: number;
  end: number;
}

/** ISO base media boxes: `[size:u32][type:4]`, with 1 meaning a 64-bit size follows. */
function readBox(bytes: Buffer, offset: number, limit: number): Box | undefined {
  if (offset + 8 > limit) return undefined;
  const declared = bytes.readUInt32BE(offset);
  const type = bytes.subarray(offset + 4, offset + 8).toString('latin1');
  let start = offset + 8;
  let size = declared;
  if (declared === 1) {
    if (start + 8 > limit) return undefined;
    const large = bytes.readBigUInt64BE(start);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    size = Number(large);
    start += 8;
  } else if (declared === 0) {
    size = limit - offset;
  }
  const end = offset + size;
  if (size < start - offset || end > limit) return undefined;
  return { type, start, end };
}

function findBox(bytes: Buffer, from: number, to: number, type: string): Box | undefined {
  let offset = from;
  for (;;) {
    const box = readBox(bytes, offset, to);
    if (box === undefined) return undefined;
    if (box.type === type) return box;
    offset = box.end;
  }
}

function probeMovieDuration(bytes: Buffer, moov: Box): number | undefined {
  const mvhd = findBox(bytes, moov.start, moov.end, 'mvhd');
  if (mvhd === undefined) return undefined;
  const version = bytes[mvhd.start];
  const timescaleAt = version === 1 ? mvhd.start + 20 : mvhd.start + 12;
  if (timescaleAt + (version === 1 ? 12 : 8) > mvhd.end) return undefined;
  const timescale = bytes.readUInt32BE(timescaleAt);
  if (timescale === 0) return undefined;
  const units =
    version === 1
      ? Number(bytes.readBigUInt64BE(timescaleAt + 4))
      : bytes.readUInt32BE(timescaleAt + 4);
  const seconds = units / timescale;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** The first track that states a visual size; an audio track states 0×0. */
function probeTrackDimensions(bytes: Buffer, moov: Box): Dimensions | undefined {
  let offset = moov.start;
  for (;;) {
    const box = readBox(bytes, offset, moov.end);
    if (box === undefined) return undefined;
    if (box.type === 'trak') {
      const tkhd = findBox(bytes, box.start, box.end, 'tkhd');
      if (tkhd !== undefined) {
        const version = bytes[tkhd.start];
        const widthAt = tkhd.start + (version === 1 ? 88 : 76);
        if (widthAt + 8 <= tkhd.end) {
          const size = dimensions(
            Math.round(bytes.readUInt32BE(widthAt) / 65_536),
            Math.round(bytes.readUInt32BE(widthAt + 4) / 65_536),
          );
          if (size !== undefined) return size;
        }
      }
    }
    offset = box.end;
  }
}

function probeIsoContainer(bytes: Buffer): MediaRenderedFormat {
  const moov = findBox(bytes, 0, bytes.length, 'moov');
  if (moov === undefined) return {};
  const durationSeconds = probeMovieDuration(bytes, moov);
  const size = probeTrackDimensions(bytes, moov);
  return {
    ...(size !== undefined ? size : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  };
}

/**
 * @returns what the container states, and `{}` for a container this cannot read
 * rather than a guess assembled from the request.
 */
export function probeRenderedFormat(kind: MediaAssetKind, bytes: Buffer): MediaRenderedFormat {
  try {
    if (kind === 'video') return probeIsoContainer(bytes);
    const size = probePng(bytes) ?? probeJpeg(bytes) ?? probeWebp(bytes) ?? probeGif(bytes);
    return size ?? {};
  } catch {
    // A malformed or truncated container is not worth failing a paid render
    // over, and a partially-read header is exactly the wrong thing to record.
    return {};
  }
}
