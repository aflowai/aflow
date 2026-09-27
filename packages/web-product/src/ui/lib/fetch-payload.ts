/**
 * Shared utility for fetching payloads from the server or decoding inline refs.
 * Used by both RunTimeline (inspector) and chat components.
 */
export async function fetchPayload(
  apiUrl: string,
  headers: () => Record<string, string>,
  ref: string,
): Promise<unknown> {
  // Decode inline refs client-side
  if (ref.startsWith('inline:')) {
    const encoded = ref.slice('inline:'.length);
    // Remove optional kind prefix (e.g. "output:", "history:")
    const colonIdx = encoded.indexOf(':');
    let b64 = encoded;
    if (colonIdx > 0 && colonIdx < 20) {
      b64 = encoded.slice(colonIdx + 1);
    }
    try {
      return JSON.parse(atob(b64));
    } catch {
      return atob(b64);
    }
  }

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
