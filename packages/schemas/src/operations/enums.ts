/**
 * Well-known enum constants for operation schemas.
 *
 * Text and embedding selections come from MODEL_SELECTIONS in
 * packages/lib/src/index.ts; media selections are derived from the wired media
 * routes. Either way the value propagates to Zod schemas, JSON Schema output,
 * flow editor dropdowns, and the get_schema operation automatically.
 */
import { z } from 'zod';
import { MODEL_SELECTIONS } from '@aflow/lib';
// Reference roles and their per-role ceiling are derived from the route
// capability descriptors, so the bound the operation schema enforces and the
// bound an authoring surface reads can never be two different numbers.
import {
  IMAGE_REFERENCE_ROLES,
  IMAGE_ROUTE_KEYS,
  MAX_IMAGE_REFERENCES_PER_ROLE,
  MAX_VIDEO_REFERENCES_PER_ROLE,
  VIDEO_ROUTE_KEYS,
  type ImageReferenceRole,
} from '../media/routeCapability.js';

// ============================================================================
// Model IDs (derived from @aflow/lib — single source of truth)
// ============================================================================

export const TEXT_MODELS = MODEL_SELECTIONS.text;
export const EMBEDDING_MODELS = MODEL_SELECTIONS.embedding;
// Media models come from the wired route table, not a curated list: the route
// is what makes one dispatchable, so the two cannot drift apart.
export const IMAGE_MODELS = IMAGE_ROUTE_KEYS;
export const VIDEO_MODELS = VIDEO_ROUTE_KEYS;

// ============================================================================
// Common value enums
// ============================================================================

/** Common aspect ratios. */
export const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '3:4', '4:3'] as const;

/** Common image sizes. */
export const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'] as const;

/** Video resolutions. */
export const VIDEO_RESOLUTIONS = ['720p', '1080p'] as const;

export { IMAGE_REFERENCE_ROLES, MAX_IMAGE_REFERENCES_PER_ROLE, MAX_VIDEO_REFERENCES_PER_ROLE };
export type { ImageReferenceRole };

/** Longest reference list any role split can produce, for one medium. */
export function maxReferences(limits: Readonly<Record<ImageReferenceRole, number>>): number {
  return Object.values(limits).reduce((sum, limit) => sum + limit, 0);
}

export const MAX_IMAGE_REFERENCES = maxReferences(MAX_IMAGE_REFERENCES_PER_ROLE);

/**
 * What a document bound to a render contributed to it. The reference roles a
 * provider conditions on, plus the slots a route takes one document in
 * directly — a plate to edit, a mask to edit through, the frames a clip is
 * interpolated between.
 */
export const MEDIA_BINDING_ROLES = [
  ...IMAGE_REFERENCE_ROLES,
  'source',
  'mask',
  'first_frame',
  'last_frame',
] as const;
export type MediaBindingRole = (typeof MEDIA_BINDING_ROLES)[number];

// ============================================================================
// Schema helper
// ============================================================================

/**
 * Helper: creates a schema that accepts well-known enum values AND arbitrary
 * strings.  Produces JSON Schema `{ anyOf: [{ enum: [...] }, { type: "string" }] }`,
 * which the editor UI renders as a dropdown with an "Other…" option.
 */
export function enumWithCustom<T extends readonly [string, ...string[]]>(
  values: T,
  maxLength = 128,
) {
  return z.enum(values).or(z.string().max(maxLength));
}
