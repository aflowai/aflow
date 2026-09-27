import { z } from 'zod';

/**
 * How a simulated endpoint touches the world.
 *
 * A response JSON Schema states the SHAPE a call returns and never which
 * collection an entity belongs to, how its identity is read, or what the call
 * mutates. Those are different facts and only the first lives in the API
 * definition, so the effect is declared once per endpoint and both the
 * deterministic read path and the generative one commit through it.
 *
 * The grammar is deliberately bounded — JSON pointers and bounded patches, no
 * predicates and no expression language. An effect the grammar cannot express
 * is a diagnostic, never a fallthrough to generation: generation commits
 * THROUGH the effect, so it cannot rescue an endpoint that has none.
 */

/** A JSON pointer into the resolved request or an entity. */
export const WorldPointerSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^\/(?:[^/~]|~[01])*(?:\/(?:[^/~]|~[01])*)*$/, {
    message:
      'A world pointer is an RFC 6901 JSON pointer (e.g. "/params/customerId"). Expressions are not supported.',
  });

/**
 * The name a read or a write gives its result.
 *
 * Names rather than positions, because a projection that sourced `reads[0]`
 * silently follows whatever ends up first when an author reorders the list.
 */
export const WorldResultNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, {
    message: 'A result name is an identifier: a letter followed by letters, digits or underscores.',
  });

/** Equality between a pointer into the request and a pointer into the entity. */
export const WorldSelectorSchema = z.object({
  entityPath: WorldPointerSchema,
  requestPath: WorldPointerSchema,
});
export type WorldSelector = z.infer<typeof WorldSelectorSchema>;

/**
 * Whether a read expects one entity or a set. Load-bearing: an empty
 * `listRefunds` is a valid 200 carrying `[]`, while an empty `getCustomer` is
 * not a valid customer, and nothing else in the model distinguishes them.
 */
export const WorldCardinalitySchema = z.enum(['one', 'many']);
export type WorldCardinality = z.infer<typeof WorldCardinalitySchema>;

/**
 * What an absent entity means. Without it the engine cannot tell an entity
 * that should be invented from one that should be reported missing — for a
 * support agent that difference is the whole escalation branch.
 */
export const WorldOnMissingSchema = z
  .union([
    z.literal('generate'),
    z.literal('error'),
    z.object({
      respond: z.number().int().min(100).max(599),
      body: z
        .unknown()
        .optional()
        .describe(
          "The body to answer with, which must satisfy the endpoint's response schema for that status class. Omitted, the engine synthesizes a minimal value from that schema — well-formed and saying nothing, which is barely better than one that fails validation.",
        ),
    }),
  ])
  .describe(
    'What an absent entity means: "generate" invents one, "error" fails the call, and an object answers a declared status. This is the escalation branch — for a support agent, whether an account is invented or reported missing is the entire scenario.',
  );
export type WorldOnMissing = z.infer<typeof WorldOnMissingSchema>;

export const WorldReadSchema = z.object({
  collection: z.string().min(1).max(128),
  select: z.array(WorldSelectorSchema).max(8).default([]),
  cardinality: WorldCardinalitySchema,
  onMissing: WorldOnMissingSchema.default('generate'),
  /** Bounds a `many` read so a projection cannot fold an unbounded set. */
  limit: z.number().int().positive().max(500).optional(),
  /** The name a write or a projection refers to this read's entities by. */
  as: WorldResultNameSchema.optional(),
});
export type WorldRead = z.infer<typeof WorldReadSchema>;

/**
 * A read that exists only to locate the targets of a transition's writes.
 *
 * It carries neither cardinality nor `onMissing`: the rule has already
 * declared the response, so there is no missing-entity branch left to take.
 */
export const WorldTransitionReadSchema = z.object({
  collection: z.string().min(1).max(128),
  select: z.array(WorldSelectorSchema).max(8).default([]),
  limit: z.number().int().positive().max(500).optional(),
  as: WorldResultNameSchema.optional(),
});
export type WorldTransitionRead = z.infer<typeof WorldTransitionReadSchema>;

export const WorldWriteOpSchema = z.enum(['create', 'update', 'delete']);
export type WorldWriteOp = z.infer<typeof WorldWriteOpSchema>;

export const WorldWriteSchema = z.object({
  collection: z.string().min(1).max(128),
  op: WorldWriteOpSchema,
  /** Entity field holding the identity. Minted from the run seed on create. */
  identity: z.string().min(1).max(128),
  /** Pointer to the request fragment the entity is built from. */
  from: WorldPointerSchema.optional(),
  /**
   * Literal field assignments applied after `from`.
   *
   * `now` is the ONLY expression, and it resolves against the virtual clock.
   * Every other value is stored exactly as written — there is no relative-time
   * vocabulary, so `'in 14 days'` becomes a due date whose literal text is
   * "in 14 days". Compute a date the caller supplies, or store `now` and let
   * the reader derive from it.
   */
  assign: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Literal field assignments applied after `from`. The only expression is `now`, which resolves against the virtual clock; every other value is stored verbatim, so a relative phrase like "in 14 days" is stored as that text rather than a date.',
    ),
  /** Which read this write targets, by name. Required for update/delete. */
  targetRead: WorldResultNameSchema.optional(),
  /** The name a projection refers to the entities this write produced by. */
  as: WorldResultNameSchema.optional(),
});
export type WorldWrite = z.infer<typeof WorldWriteSchema>;

/**
 * Where a projection's entities come from.
 *
 * A write is projectable so an endpoint can return what it just created —
 * `createRefund` reads the order, creates the refund, and answers with the
 * refund. Sourcing reads alone left that case inexpressible.
 */
export const WorldProjectionSourceSchema = z.union([
  z.object({ read: WorldResultNameSchema }).strict(),
  z.object({ write: WorldResultNameSchema }).strict(),
]);
export type WorldProjectionSource = z.infer<typeof WorldProjectionSourceSchema>;

/** How resulting entities render into the response body. */
export const WorldProjectionSchema = z.object({
  /** Pointer in the response body where the entities land. `/` is the whole body. */
  bodyPath: WorldPointerSchema.or(z.literal('/')),
  /** The named read or write supplying them. */
  from: WorldProjectionSourceSchema,
  /** Entity fields to include. Empty = the whole entity. */
  fields: z.array(z.string().min(1).max(128)).max(64).default([]),
});
export type WorldProjection = z.infer<typeof WorldProjectionSchema>;

/**
 * Every reference a set of reads, writes and projections makes to itself,
 * checked at authoring time. A write whose target or a projection whose source
 * resolves to nothing would answer or mutate silently, and a simulation that
 * quietly does neither is indistinguishable from one that works.
 */
function refineResultLinkage(
  node: {
    reads: ReadonlyArray<WorldRead | WorldTransitionRead>;
    writes: readonly WorldWrite[];
    project?: readonly WorldProjection[];
  },
  ctx: z.RefinementCtx,
): void {
  const readNames = new Map<string, number>();
  for (const [i, read] of node.reads.entries()) {
    if (read.as === undefined) continue;
    if (readNames.has(read.as)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reads', i, 'as'],
        message: `Result name "${read.as}" is already used by another read.`,
      });
      continue;
    }
    readNames.set(read.as, i);
  }

  const writeNames = new Map<string, number>();
  for (const [i, write] of node.writes.entries()) {
    if (write.as === undefined) continue;
    if (writeNames.has(write.as)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['writes', i, 'as'],
        message: `Result name "${write.as}" is already used by another write.`,
      });
      continue;
    }
    writeNames.set(write.as, i);
  }

  for (const [i, write] of node.writes.entries()) {
    if (write.op === 'create') continue;
    if (write.targetRead === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['writes', i, 'targetRead'],
        message: `A '${write.op}' write must name the read whose entities it applies to.`,
      });
      continue;
    }
    if (!readNames.has(write.targetRead)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['writes', i, 'targetRead'],
        message: `targetRead "${write.targetRead}" names no read here. Give that read an "as" name.`,
      });
    }
  }

  const projections = node.project ?? [];
  for (const [i, projection] of projections.entries()) {
    // A projection at `/` IS the body, so anything beside it renders nowhere.
    // The renderer would answer with the root one and drop the rest, which is
    // the silent no-op the linkage check exists to make impossible.
    if (projection.bodyPath === '/' && projections.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['project', i, 'bodyPath'],
        message:
          'A projection at "/" renders the whole body, so it must be the only one. Give each projection its own body path.',
      });
    }
    if ('read' in projection.from) {
      if (!readNames.has(projection.from.read)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['project', i, 'from', 'read'],
          message: `from.read "${projection.from.read}" names no read here. Give that read an "as" name.`,
        });
      }
      continue;
    }
    const at = writeNames.get(projection.from.write);
    if (at === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['project', i, 'from', 'write'],
        message: `from.write "${projection.from.write}" names no write here. Give that write an "as" name.`,
      });
      continue;
    }
    if (node.writes[at]?.op === 'delete') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['project', i, 'from', 'write'],
        message: `from.write "${projection.from.write}" is a delete, which leaves no entity to render.`,
      });
    }
  }
}

/**
 * The world mutation a rule applies with its declared response.
 *
 * It carries its OWN reads because an update or a delete needs a target set
 * and a rule has no effect to borrow one from — resolved against nothing, such
 * a write answers the call and changes nothing, which reads as a working
 * simulation and is the one outcome the grammar must not admit.
 */
export const WorldTransitionSchema = z
  .object({
    reads: z.array(WorldTransitionReadSchema).max(4).default([]),
    writes: z.array(WorldWriteSchema).max(4).default([]),
  })
  .superRefine(refineResultLinkage);
export type WorldTransition = z.infer<typeof WorldTransitionSchema>;

export const WorldEffectSchema = z
  .object({
    reads: z.array(WorldReadSchema).max(8).default([]),
    /** Empty for a pure lookup — a read is not forced to name a collection it does not touch. */
    writes: z.array(WorldWriteSchema).max(8).default([]),
    project: z.array(WorldProjectionSchema).max(8).default([]),
    /** Response status when the effect resolves cleanly. */
    status: z.number().int().min(100).max(599).default(200),
  })
  .superRefine(refineResultLinkage);
export type WorldEffect = z.infer<typeof WorldEffectSchema>;
