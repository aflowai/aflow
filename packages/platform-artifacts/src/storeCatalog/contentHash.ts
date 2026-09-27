import { createHash } from 'node:crypto';
import { canonicalCatalogEntryContent, type CatalogEntry } from '@aflow/schemas';

export function catalogEntryContentHash(entry: CatalogEntry): string {
  return createHash('sha256').update(canonicalCatalogEntryContent(entry), 'utf8').digest('hex');
}
