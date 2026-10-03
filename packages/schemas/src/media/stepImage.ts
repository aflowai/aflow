/**
 * An image a step returns.
 *
 * A step that produces a picture — a page screenshot, a rendered chart — returns
 * this shape at an output path its operation declares. The bytes stay behind
 * the reference; the agent turn reads the declared paths, and the request
 * builder decides whether the model sees the picture or only its description
 * and size.
 */
import { z } from 'zod';
import { PayloadRefSchema, parsePayloadRef } from '../runtime/payloadRef.js';

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

/** The most images taken from one step's output. */
export const MAX_STEP_IMAGES_PER_OUTPUT = 8;

/**
 * Where in an operation's output a `StepImage` sits: property names joined by
 * dots, where a name ending in `[]` takes every element of the array there —
 * `image`, `page.screenshot`, `frames[]`.
 */
export const StepImageOutputPathSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(?:\[\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\])?)*$/,
    'An image output path is property names joined by dots, each optionally ending in [] — for example "image" or "frames[]".',
  );
export type StepImageOutputPath = z.infer<typeof StepImageOutputPathSchema>;

/**
 * The output paths an operation declares its images at. Only an operation
 * that declares them has its output read for images, and only at these paths.
 */
export const StepImageOutputPathsSchema = z
  .array(StepImageOutputPathSchema)
  .min(1)
  .max(MAX_STEP_IMAGES_PER_OUTPUT)
  .refine((paths) => new Set(paths).size === paths.length, 'Each image output path once.');
export type StepImageOutputPaths = z.infer<typeof StepImageOutputPathsSchema>;

/** A `StepImage` as the output's text shows it: everything but the reference. */
export type StepImageStub = Omit<StepImage, 'ref'>;

function stubAt(value: unknown, segments: readonly string[]): unknown {
  const [segment, ...rest] = segments;
  if (segment === undefined) {
    const parsed = StepImageSchema.safeParse(value);
    if (!parsed.success) return value;
    const { ref: _ref, ...stub } = parsed.data;
    return stub satisfies StepImageStub;
  }
  const many = segment.endsWith('[]');
  const name = many ? segment.slice(0, -2) : segment;
  const child = ownProperty(value, name);
  if (child === undefined) return value;
  if (many && !Array.isArray(child)) return value;
  const next = many
    ? (child as unknown[]).map((element) => stubAt(element, rest))
    : stubAt(child, rest);
  return { ...(value as Record<string, unknown>), [name]: next };
}

/**
 * The output with every image at the declared paths replaced by its stub. The
 * text of a tool result is built from this, so no reference reaches the model
 * through it — not one carried as an image, which arrives beside the text, and
 * not one withheld, whose reference was never the model's to read. Every image
 * at a declared path is stubbed, past the count `findStepImages` carries too.
 */
export function stubStepImages(output: unknown, paths: readonly StepImageOutputPath[]): unknown {
  return paths.reduce((current, path) => stubAt(current, path.split('.')), output);
}

/** The step whose output is being read — the only producer its images may name. */
export interface StepImageProducer {
  tenantId: string;
  runId: string;
  stepExecutionId: string;
}

export interface StepImagesFound {
  images: StepImage[];
  /** One line per image found and not carried, saying where and why. */
  withheld: string[];
}

function ownProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

/** The values at one declared path, each with the location it was read from. */
function valuesAt(
  output: unknown,
  path: StepImageOutputPath,
  limit: number,
): Array<{ at: string; value: unknown }> {
  let current: Array<{ at: string; value: unknown }> = [{ at: '', value: output }];
  for (const segment of path.split('.')) {
    const many = segment.endsWith('[]');
    const name = many ? segment.slice(0, -2) : segment;
    const next: Array<{ at: string; value: unknown }> = [];
    for (const { at, value } of current) {
      const child = ownProperty(value, name);
      const childAt = at === '' ? name : `${at}.${name}`;
      if (!many) {
        if (child !== undefined) next.push({ at: childAt, value: child });
      } else if (Array.isArray(child)) {
        for (let i = 0; i < child.length && next.length < limit; i++) {
          next.push({ at: `${childAt}[${String(i)}]`, value: child[i] });
        }
      }
    }
    current = next.slice(0, limit);
  }
  return current;
}

function storedByProducer(ref: string, producer: StepImageProducer): boolean {
  const parsed = parsePayloadRef(ref);
  return (
    parsed?.form === 'object' &&
    parsed.layout === 'run' &&
    parsed.tenantId === producer.tenantId &&
    parsed.runId === producer.runId &&
    parsed.stepExecutionId === producer.stepExecutionId
  );
}

/**
 * The images at the output paths the step's operation declares, in
 * declaration order.
 *
 * A carried image's reference is read by the executor and its bytes sent to
 * the model, so the output naming a reference is no authority to read it: an
 * image is carried only when its reference names a payload the producing step
 * itself stored — same tenant, run and step execution. An inline reference, or
 * one naming any other payload, is withheld with a line saying so.
 */
export function findStepImages(
  output: unknown,
  paths: readonly StepImageOutputPath[],
  producer: StepImageProducer,
): StepImagesFound {
  const found: StepImagesFound = { images: [], withheld: [] };
  let remaining = MAX_STEP_IMAGES_PER_OUTPUT;
  for (const path of paths) {
    if (remaining <= 0) break;
    for (const { at, value } of valuesAt(output, path, remaining)) {
      const parsed = StepImageSchema.safeParse(value);
      if (!parsed.success) continue;
      remaining--;
      if (storedByProducer(parsed.data.ref, producer)) {
        found.images.push(parsed.data);
      } else {
        found.withheld.push(
          `The image at ${at} was not shown: ` +
            (parsed.data.ref.startsWith('inline:')
              ? 'it is carried inline, not stored by this step.'
              : 'its reference names a payload this step did not store.'),
        );
      }
    }
  }
  return found;
}
