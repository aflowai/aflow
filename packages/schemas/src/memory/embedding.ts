/**
 * A space's memory embedding: the one model its vectors come from, and the
 * state of its index (Plan 315 D12).
 */
import { z } from 'zod';
import { MemoryEmbeddingStatusSchema } from '../operations/memory.js';

export const EmbeddingModelChoiceSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  provider: z.string(),
  dimensions: z.number().int().positive(),
  /** USD per million input tokens; null where the catalog carries no price. */
  pricePer1M: z.number().nullable(),
  available: z.boolean(),
  /** Why the space cannot use this model now; null when it can. */
  unavailableReason: z.string().nullable(),
});
export type EmbeddingModelChoice = z.infer<typeof EmbeddingModelChoiceSchema>;

export const SpaceMemoryEmbeddingSchema = z.object({
  /** The model the space's vectors come from, or would on the next embed. */
  model: EmbeddingModelChoiceSchema.nullable(),
  /** Whether the space holds this model, as opposed to the default it would pin. */
  pinned: z.boolean(),
  state: z.enum(['ready', 'unconfigured']),
  /** Who pays for the calls: the space's own key, or the deployment's. */
  funding: z.enum(['space', 'platform']).nullable(),
  /** Why the space cannot embed; null when it can. */
  reason: z.string().nullable(),
  choices: z.array(EmbeddingModelChoiceSchema),
  documents: z.record(MemoryEmbeddingStatusSchema, z.number().int().nonnegative()),
  /** Estimated input tokens to embed every embeddable document once. */
  reindexTokens: z.number().int().nonnegative(),
  lastError: z
    .object({ path: z.string(), message: z.string(), at: z.string().datetime() })
    .nullable(),
});
export type SpaceMemoryEmbedding = z.infer<typeof SpaceMemoryEmbeddingSchema>;

export const SetSpaceMemoryEmbeddingBodySchema = z.object({ model: z.string().min(1) });
