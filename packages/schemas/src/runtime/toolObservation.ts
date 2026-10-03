/**
 * A tool result that observes something a later result makes stale.
 *
 * An operation whose result is a look at one thing — a page — declares the
 * group of operations that look at the same kind of thing and where in its
 * output that thing's key sits. The agent turn shows the newest result per
 * group and key in full and every earlier one as its receipt: the output
 * without the fields the declaration names as the observation.
 */
import { z } from 'zod';

const OutputFieldNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'An observed field is one top-level output property name.');

const OutputKeyPathSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/,
    'A key path is output property names joined by dots — for example "pageId".',
  );

const ObservationGroupSchema = z
  .string()
  .min(1)
  .describe('What is observed, shared by every operation that observes or ends it.');

/**
 * Declared on an operation's registration. `observes`: the result is a look at
 * the thing whose key is at `keyPath`, and `observedFields` are the bulky part
 * a later look replaces. `ends`: after this result the thing is gone, and
 * every earlier look at it is stale.
 */
export const OperationObservationSchema = z.discriminatedUnion('role', [
  z
    .object({
      role: z.literal('observes'),
      group: ObservationGroupSchema,
      keyPath: OutputKeyPathSchema,
      observedFields: z
        .array(OutputFieldNameSchema)
        .min(1)
        .refine((fields) => new Set(fields).size === fields.length, 'Each observed field once.'),
      currentStateOperation: z
        .string()
        .min(1)
        .describe('The operation that returns the current state, named in a reduced result.'),
    })
    .strict(),
  z
    .object({
      role: z.literal('ends'),
      group: ObservationGroupSchema,
      keyPath: OutputKeyPathSchema,
    })
    .strict(),
]);
export type OperationObservation = z.infer<typeof OperationObservationSchema>;

/**
 * Stamped on a tool-result envelope by the orchestrator from the declaration
 * and the step's output. Never shown to the model: assembly removes it, and
 * reads it to decide whether the result is shown in full or as `receipt`.
 */
export const ToolResultObservationSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('observes'),
    group: ObservationGroupSchema,
    key: z.string().min(1),
    /** The result's summary, built from the output without its observed fields. */
    receipt: z.string(),
    currentStateOperation: z.string().min(1),
  }),
  z.object({
    role: z.literal('ends'),
    group: ObservationGroupSchema,
    key: z.string().min(1),
  }),
]);
export type ToolResultObservation = z.infer<typeof ToolResultObservationSchema>;

/** The key at `keyPath` in a step's output, when it is a non-empty string or a number. */
export function observationKeyOf(output: unknown, keyPath: string): string | undefined {
  let current: unknown = output;
  for (const segment of keyPath.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === 'number' && Number.isFinite(current)) return String(current);
  return typeof current === 'string' && current.length > 0 ? current : undefined;
}

/** The output with the observed top-level fields removed. */
export function withoutObservedFields(output: unknown, fields: readonly string[]): unknown {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return output;
  const dropped = new Set(fields);
  return Object.fromEntries(
    Object.entries(output as Record<string, unknown>).filter(([name]) => !dropped.has(name)),
  );
}
