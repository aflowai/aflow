/** Reused fatal decoder — `decode()` is stateless without `{ stream: true }`. */
const UTF8_FATAL_DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * A file is text when its bytes are valid UTF-8, binary otherwise.
 * An empty buffer decodes to '' and counts as text.
 */
export function bytesAreUtf8(buf: Buffer): boolean {
  try {
    UTF8_FATAL_DECODER.decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** Extensions for formats that are binary even if their bytes decode as UTF-8. */
const BINARY_EXTENSIONS = new Set([
  'parquet',
  'pkl',
  'pickle',
  'npy',
  'npz',
  'joblib',
  'pt',
  'pth',
  'onnx',
  'pb',
  'h5',
  'hdf5',
  'zip',
  'gz',
  'gzip',
  'tar',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'tiff',
  'ico',
  'pdf',
  'wasm',
  'so',
  'bin',
  // Media containers. A short clip's bytes can decode as UTF-8 by accident, and
  // a container that lands on the text lane is unreadable and unservable.
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mkv',
  'avi',
  'mp3',
  'm4a',
  'wav',
  'ogg',
  'flac',
  'aac',
]);

export function hasBinaryExtension(path: string): boolean {
  const ext = (/\.([^./]+)$/.exec(path)?.[1] ?? '').toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/** The lane decision: binary iff non-UTF-8 bytes OR a known-binary extension. */
export function isBinaryContent(bytes: Buffer, path: string): boolean {
  return !bytesAreUtf8(bytes) || hasBinaryExtension(path);
}

/**
 * Where the bytes actually are: `storeBytes` addresses a `.bin` object and
 * `retrieveBytes` is the only way to read it, while every other ref (inline or
 * `.json`) belongs to the lane `retrieve` can parse. A doc's docType does not
 * decide this — the write lane does, and the two disagree in both directions.
 */
export function isBinaryPayloadRef(payloadRef: string): boolean {
  return payloadRef.endsWith('.bin');
}
