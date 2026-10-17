import { z } from 'zod';
import { PinnedMemoryRefSchema } from '../media/asset.js';

export const SOURCE_REF_HINT =
  'Pass the pinned memory reference a media step returns — an entry of its `assets`, carrying ' +
  'path, version and contentHash — or a PayloadRef of stored bytes. For a document no render ' +
  "just produced, read its pin with memory.store.get({ target: { path }, view: 'stat' }). A bare " +
  'path is not a form here, and a version that no longer exists or a hash that disagrees fails ' +
  'the step rather than rendering from whatever the path now holds.';

/**
 * Where a media operation reads an input image from.
 *
 * The pinned form is exactly what every media operation returns, so an asset
 * out of one render is the input of the next without translation. A bare path
 * is deliberately not a form: the render's receipt states which version of
 * which document it read, and a path resolves to whatever it holds at the
 * moment of reading, which would make that statement unprovable.
 */
export const MediaSourceRefSchema = z
  .union([
    PinnedMemoryRefSchema,
    z
      .string()
      .min(1)
      .describe(
        'PayloadRef of stored image bytes — a platform handle a workflow step is wired to, which ' +
          'an agent has no way to mint.',
      ),
  ])
  .describe(SOURCE_REF_HINT);
export type MediaSourceRef = z.infer<typeof MediaSourceRefSchema>;
