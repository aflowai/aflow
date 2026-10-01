/**
 * Shared utility for fetching payloads from the server or decoding inline refs.
 * Used by both RunTimeline (inspector) and chat components.
 */
export function isInlinePayloadRef(ref: string): boolean {
  return ref.startsWith('inline:');
}

/** The value an `inline:` ref carries, decoded without a request. */
export function decodeInlinePayload(ref: string): unknown {
  const encoded = ref.slice('inline:'.length);
  // Remove optional kind prefix (e.g. "output:", "history:")
  const colonIdx = encoded.indexOf(':');
  let b64 = encoded;
  if (colonIdx > 0 && colonIdx < 20) {
    b64 = encoded.slice(colonIdx + 1);
  }
  const text = decodeBase64Utf8(b64);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// The server encodes inline refs from UTF-8 bytes; `atob` alone yields one
// Latin-1 char per byte and garbles anything outside ASCII.
function decodeBase64Utf8(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (char) => char.charCodeAt(0)));
}

export async function fetchPayload(
  apiUrl: string,
  headers: () => Record<string, string>,
  ref: string,
): Promise<unknown> {
  if (isInlinePayloadRef(ref)) return decodeInlinePayload(ref);

  // Fetch from server for non-inline refs (gs://...)
  const res = await fetch(`${apiUrl}/payloads?ref=${encodeURIComponent(ref)}`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
