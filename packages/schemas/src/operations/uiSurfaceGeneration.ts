import { z } from 'zod';

/**
 * Error code a `ui.surface.*` step fails with when generation produced no
 * surface — no `createSurface` mutation passed the assembler and validator,
 * so nothing reached the chat. The run-view reducer keys the failed inline
 * card on it.
 */
export const SURFACE_GENERATION_EMPTY_ERROR_CODE = 'SURFACE_GENERATION_EMPTY';

export const SurfaceGenerationEmptyDetailsSchema = z.object({
  surfaceId: z.string(),
  mutationCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  /** Assembler and validator diagnostics, oldest first; bounded. */
  errors: z.array(z.string()),
  finishReason: z.string().optional(),
});
export type SurfaceGenerationEmptyDetails = z.infer<typeof SurfaceGenerationEmptyDetailsSchema>;
