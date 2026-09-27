import { z } from 'zod';

/**
 * Icon reference for anything the UI has to identify visually — a store listing
 * or an integration definition. An absent icon means the UI renders its
 * deterministic initials fallback; artwork is never required.
 */
export const IconRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('brand'),
    assetId: z
      .string()
      .min(1)
      .max(128)
      .regex(
        /^[a-z0-9_-]+$/,
        'Must contain only lowercase letters, numbers, underscores, and hyphens',
      )
      .describe('Curated brand SVG shipped with the app; must resolve in the brand asset set'),
  }),
  z.object({
    kind: z.literal('phosphor'),
    name: z.string().min(1).max(128).describe('Phosphor icon name, rendered on a tinted tile'),
    color: z.string().min(1).max(64).optional(),
  }),
  z.object({
    kind: z.literal('generated'),
    svg: z.string().min(1).max(65_536).describe('Inline SVG markup, checked into the registry'),
  }),
]);
export type IconRef = z.infer<typeof IconRefSchema>;
