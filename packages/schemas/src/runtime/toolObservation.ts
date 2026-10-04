/**
 * A tool result that observes something a later result makes stale.
 *
 * An operation whose result is a look at one thing — a page — declares the
 * facets of that thing its result holds: which output fields, where the key of
 * the thing is, the further keys that tell one part of a facet from another,
 * whether what it holds expires at any later look or only at one that covers
 * it, and the operation that returns the facet as it is now. The agent turn
 * reduces a result only in the
 * facets a later result replaced, and in every facet once the thing moved on
 * or ended.
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
  .describe(
    'The kind of thing observed, shared by every operation that observes, moves or ends it.',
  );

const FacetNameSchema = z
  .string()
  .regex(/^[a-z][a-z_]*$/, 'A facet is a lower-case name, such as "outline".');

/**
 * Each set of facets a later result can make stale gets its own stored
 * receipt, so a declaration's receipts grow as 2^facets.
 */
const MAX_FACETS_PER_DECLARATION = 4;

const observedFacetShape = {
  facet: FacetNameSchema,
  fields: z
    .array(OutputFieldNameSchema)
    .min(1)
    .refine((fields) => new Set(fields).size === fields.length, 'Each field once.')
    .describe('The output fields holding this facet: what a later look at it replaces.'),
  keyPath: OutputKeyPathSchema.describe('Where the key of the observed thing is.'),
  partKeyPaths: z
    .array(OutputKeyPathSchema)
    .min(1)
    .optional()
    .describe(
      'Further keys that tell one part of the facet from another. A later look replaces this ' +
        'one only when every part key matches; a key absent from the output is the empty part.',
    ),
  onlyWhenAbsent: OutputKeyPathSchema.optional().describe(
    'The result holds this facet only when its output has nothing at this path.',
  ),
  currentStateOperation: z
    .string()
    .min(1)
    .describe('The operation that returns this facet as it is now, named in a reduced result.'),
};

const ObservedFacetSchema = z.discriminatedUnion('expires', [
  z
    .object({
      ...observedFacetShape,
      expires: z
        .literal('on_any_later_look')
        .describe(
          'What the facet holds is good only until the thing is looked at again — as a ' +
            "page's element references resolve only in the newest look at it — so any later " +
            'look at the same part replaces it, however much either left out.',
        ),
    })
    .strict(),
  z
    .object({
      ...observedFacetShape,
      expires: z
        .literal('on_covering_look')
        .describe(
          'What the facet holds stays true after a later look, so a later look at the same ' +
            'part replaces it only when it left out no more of the part than this one did.',
        ),
      withheldAt: OutputKeyPathSchema.describe(
        'Where the result says how much of this part it left out at its bound: a count, or ' +
          'counts by kind, which are added up; nothing there is nothing left out.',
      ),
    })
    .strict(),
]);
export type ObservedFacet = z.infer<typeof ObservedFacetSchema>;

/**
 * Declared on an operation's registration. `facets`: what of a thing the
 * result holds. `moves`: when the output is `true` at `whenTrueAt`, the thing
 * at `keyPath` is somewhere else now, and every earlier look at any facet of
 * it is stale. `ends`: the things at these paths are gone after this result.
 */
export const OperationObservationSchema = z
  .object({
    group: ObservationGroupSchema,
    facets: z.array(ObservedFacetSchema).min(1).max(MAX_FACETS_PER_DECLARATION).optional(),
    moves: z
      .object({ keyPath: OutputKeyPathSchema, whenTrueAt: OutputKeyPathSchema })
      .strict()
      .optional(),
    ends: z.array(OutputKeyPathSchema).min(1).optional(),
  })
  .strict()
  .refine(
    (declaration) =>
      declaration.facets !== undefined ||
      declaration.moves !== undefined ||
      declaration.ends !== undefined,
    'An observation declares the facets its result holds, a move, or an end.',
  );
export type OperationObservation = z.infer<typeof OperationObservationSchema>;

const ObservationKeySchema = z.string().min(1);

const stampedFacetShape = {
  facet: FacetNameSchema,
  key: ObservationKeySchema,
  part: z.array(z.object({ path: z.string(), value: z.string() })),
  /** The declared fields the output has. */
  fields: z.array(z.string()),
  currentStateOperation: z.string().min(1),
};

/**
 * Stamped on a tool-result envelope by the orchestrator from the declaration
 * and the step's output. Never shown to the model: assembly removes it, and
 * reads it to decide which fields of the result are still shown.
 */
export const ToolResultObservationSchema = z.object({
  group: ObservationGroupSchema,
  facets: z.array(
    z.discriminatedUnion('expires', [
      z.object({ ...stampedFacetShape, expires: z.literal('on_any_later_look') }),
      z.object({
        ...stampedFacetShape,
        expires: z.literal('on_covering_look'),
        /** What the result left out of the part, read at the declared `withheldAt`. */
        withheld: z.number().nonnegative(),
      }),
    ]),
  ),
  /** The result summarised without each set of fields a later result can make stale. */
  receipts: z.array(z.object({ without: z.array(z.string()).min(1), text: z.string() })),
  moved: z.array(ObservationKeySchema),
  ended: z.array(ObservationKeySchema),
});
export type ToolResultObservation = z.infer<typeof ToolResultObservationSchema>;
export type StampedFacet = ToolResultObservation['facets'][number];

function valueAt(output: unknown, keyPath: string): unknown {
  let current: unknown = output;
  for (const segment of keyPath.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** The count at `path`, or the sum of the counts there; 0 when there is none. */
function withheldAt(output: unknown, path: string): number {
  const value = valueAt(output, path);
  const counts =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.values(value)
      : [value];
  return counts.reduce<number>(
    (sum, count) => (typeof count === 'number' && Number.isFinite(count) ? sum + count : sum),
    0,
  );
}

/** The key at `keyPath` in a step's output, when it is a non-empty string or a number. */
export function observationKeyOf(output: unknown, keyPath: string): string | undefined {
  const value = valueAt(output, keyPath);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The output with the named top-level fields removed. */
export function withoutObservedFields(output: unknown, fields: readonly string[]): unknown {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return output;
  const dropped = new Set(fields);
  return Object.fromEntries(
    Object.entries(output as Record<string, unknown>).filter(([name]) => !dropped.has(name)),
  );
}

/**
 * The fields a result no longer shows once the facets at `stale` are stale:
 * those every facet holding them is. A field another facet still holds stays.
 */
export function staleFieldsOf(
  facets: ReadonlyArray<Pick<StampedFacet, 'fields'>>,
  stale: ReadonlySet<number>,
): string[] {
  const fields = new Set(facets.flatMap((facet) => facet.fields));
  return [...fields]
    .filter((field) =>
      facets.every((facet, index) => stale.has(index) || !facet.fields.includes(field)),
    )
    .sort();
}

/**
 * The stamp for a finished step's output under its operation's declaration,
 * or nothing when the output holds no facet and neither moves nor ends a
 * thing. `summarize` renders each receipt exactly as the full result is
 * rendered, so a reduced result reads like the full one with the bulk out.
 */
export function toolResultObservationOf(
  declaration: OperationObservation,
  output: unknown,
  summarize: (output: unknown) => string,
): ToolResultObservation | undefined {
  const facets: StampedFacet[] = [];
  for (const facet of declaration.facets ?? []) {
    const key = observationKeyOf(output, facet.keyPath);
    if (key === undefined) continue;
    if (facet.onlyWhenAbsent !== undefined && valueAt(output, facet.onlyWhenAbsent) !== undefined) {
      continue;
    }
    const stamped = {
      facet: facet.facet,
      key,
      part: (facet.partKeyPaths ?? []).map((path) => ({
        path,
        value: observationKeyOf(output, path) ?? '',
      })),
      fields: facet.fields.filter((field) => valueAt(output, field) !== undefined),
      currentStateOperation: facet.currentStateOperation,
    };
    facets.push(
      facet.expires === 'on_covering_look'
        ? { ...stamped, expires: facet.expires, withheld: withheldAt(output, facet.withheldAt) }
        : { ...stamped, expires: facet.expires },
    );
  }
  const movedKey =
    declaration.moves !== undefined && valueAt(output, declaration.moves.whenTrueAt) === true
      ? observationKeyOf(output, declaration.moves.keyPath)
      : undefined;
  const moved = movedKey !== undefined ? [movedKey] : [];
  const ended = (declaration.ends ?? []).flatMap((path) => observationKeyOf(output, path) ?? []);
  if (facets.length === 0 && moved.length === 0 && ended.length === 0) return undefined;

  const receipts = new Map<string, { without: string[]; text: string }>();
  for (let subset = 1; subset < 1 << facets.length; subset += 1) {
    const stale = new Set(
      facets.flatMap((_facet, index) => (subset & (1 << index) ? [index] : [])),
    );
    const without = staleFieldsOf(facets, stale);
    const id = without.join('\u0000');
    if (without.length === 0 || receipts.has(id)) continue;
    receipts.set(id, { without, text: summarize(withoutObservedFields(output, without)) });
  }
  return { group: declaration.group, facets, receipts: [...receipts.values()], moved, ended };
}
