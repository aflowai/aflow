/**
 * An image a step returns.
 *
 * A step that produces a picture — a page screenshot, a rendered chart — returns
 * this shape somewhere in its output. The bytes stay behind the reference; the
 * agent turn finds the shape, and the request builder decides whether the model
 * sees the picture or only its description and size.
 */
import { z } from 'zod';
import { PayloadRefSchema } from '../runtime/payloadRef.js';

export const STEP_IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const StepImageContentTypeSchema = z.enum(STEP_IMAGE_CONTENT_TYPES);
export type StepImageContentType = z.infer<typeof StepImageContentTypeSchema>;

export const STEP_IMAGE_DESCRIPTION_MAX_CHARS = 200;

export const StepImageSchema = z
  .object({
    ref: PayloadRefSchema.describe(
      'Payload reference to the image bytes, stored as { data: <base64>, mimeType }.',
    ),
    contentType: StepImageContentTypeSchema.describe('Image format.'),
    sizeBytes: z.number().int().positive().describe('Size of the image in bytes.'),
    width: z.number().int().positive().describe('Width in pixels.'),
    height: z.number().int().positive().describe('Height in pixels.'),
    description: z
      .string()
      .min(1)
      .max(STEP_IMAGE_DESCRIPTION_MAX_CHARS)
      .regex(/^[^\r\n]*$/, 'The description is one line.')
      .optional()
      .describe(
        'One line saying what the image shows. A model that cannot see images reads this instead.',
      ),
  })
  .strict();
export type StepImage = z.infer<typeof StepImageSchema>;

/** How deep into a step's output the search looks for images. */
export const STEP_IMAGE_SEARCH_DEPTH = 4;
/** The most images taken from one step's output. */
export const MAX_STEP_IMAGES_PER_OUTPUT = 8;

/**
 * Every value in a step's output that is a `StepImage`, in document order.
 * Bounded by depth and count: an output is arbitrary data, and a large one must
 * not turn into an unbounded walk on the result path.
 */
export function findStepImages(output: unknown): StepImage[] {
  const found: StepImage[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (found.length >= MAX_STEP_IMAGES_PER_OUTPUT) return;
    if (value === null || typeof value !== 'object') return;
    if (!Array.isArray(value)) {
      const parsed = StepImageSchema.safeParse(value);
      if (parsed.success) {
        found.push(parsed.data);
        return;
      }
    }
    if (depth >= STEP_IMAGE_SEARCH_DEPTH) return;
    const children: unknown[] = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) visit(child, depth + 1);
  };
  visit(output, 0);
  return found;
}
