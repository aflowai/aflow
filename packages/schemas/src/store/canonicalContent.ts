import type { CatalogEntry } from './catalogEntry.js';

export const CANONICAL_CONTENT_EXCLUDED_FIELDS = [
  'version',
  'status',
  'icon',
  'tagline',
  'description',
  'tags',
  'category',
] as const;

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * Deterministic JSON of a listing's behavior-bearing content: payload, host
 * manifest, identity and trust fields — with presentation-only fields
 * excluded, and `version` excluded because the hash of this string is what
 * guards the version bump (a content change without a bump is detectable
 * precisely because the version is not part of the content). The payload's
 * own `version` is the same field — the entry schema pins it to the envelope
 * version — so it is excluded with it. Stable key ordering at every depth;
 * dependency-free so it runs client-side — the hashing itself happens where
 * the registry lives.
 */
export function canonicalCatalogEntryContent(entry: CatalogEntry): string {
  const excluded: readonly string[] = CANONICAL_CONTENT_EXCLUDED_FIELDS;
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (excluded.includes(key)) continue;
    content[key] = value;
  }
  const payload = content['payload'];
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const { version: _version, ...payloadContent } = payload as Record<string, unknown>;
    content['payload'] = payloadContent;
  }
  return stableStringify(content);
}
