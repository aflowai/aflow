/**
 * The definition-hash convention: sha256 hex over the canonical serialization
 * of the parsed definition. Canonical (keys sorted at every level) so a jsonb
 * round-trip hashes identically, and computed over the PARSED form so schema
 * defaults are materialized before pinning.
 */
import { createHash } from 'node:crypto';
import type { AppletDefinition } from '@aflow/schemas';
import { canonicalJsonStringify } from './json.js';

export function computeAppletDefinitionHash(definition: AppletDefinition): string {
  return createHash('sha256').update(canonicalJsonStringify(definition), 'utf8').digest('hex');
}
