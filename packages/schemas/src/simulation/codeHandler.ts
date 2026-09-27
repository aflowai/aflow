import { z } from 'zod';

/**
 * A response handler written as code, for the endpoints a grammar cannot reach.
 *
 * The declarative effect can select entities, copy request fragments and assign
 * literals. It cannot compute: no arithmetic, no aggregation, no conditional,
 * no date offset. So a statement that sums instalments, a booking that
 * decrements the remaining spots, or a reschedule that refuses an overdue
 * instalment either reaches a model on every call — 16-62s and real tokens for
 * arithmetic — or silently leaves the world wrong.
 *
 * A function needs no grammar, and extending one case at a time is how a
 * grammar becomes a bad programming language. What is bounded instead is the
 * SHAPE: pure, synchronous, no I/O. The host materializes what the handler
 * declared, runs it, and applies what it returns — against the collections it
 * declared, holding each write to that collection's schema, and accepting only
 * the entity ids it was given.
 */
export const SimulationCodeHandlerSchema = z.object({
  /**
   * Collections the handler is given, and the only ones it can see.
   *
   * Materialized through the same persona-scoped read every other rung uses, so
   * naming a collection grants no more than a declared effect would. It is also
   * the only thing the readiness report can know about an endpoint whose body
   * is opaque — without it, `collection_unread` could not tell a seeded world
   * that nothing reads from one a handler uses.
   */
  collections: z.array(z.string().min(1).max(128)).max(64).default([]),
  code: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      'The function body. Receives `request`, `caller`, `now`, `world` and `newId`, and returns `{ status, body, mutations? }`. ' +
        'Runs in an isolate: no `fetch`, no `require`, no `Math.random`, no filesystem. ' +
        '`Date` IS available and is frozen to the run clock — `Date.now()` and `new Date()` answer with `now`, local time reads as UTC, and parsing, formatting and arithmetic work normally, so `new Date(now).toISOString()` is the way to write a timestamp. ' +
        'An entity id for a `create` must come from `newId(collection)`; an id the handler chooses is refused, because it cannot be replayed and a fixed one would have every call write the same row.',
    ),
  /** Milliseconds the handler may run before it is killed. */
  timeoutMs: z.number().int().min(1).max(5_000).default(1_000),
});
export type SimulationCodeHandler = z.infer<typeof SimulationCodeHandlerSchema>;

/** What a handler must return. Anything else is a contract violation. */
export const CodeHandlerResultSchema = z.object({
  status: z.number().int().min(100).max(599),
  body: z.unknown(),
  mutations: z
    .array(
      z.union([
        z.object({
          collection: z.string().min(1).max(128),
          op: z.literal('create'),
          /**
           * From `newId(collection)`, and checked against what the host handed
           * out. Supplied rather than minted on the way out so the handler can
           * put the same id in its response body — an endpoint whose schema
           * requires the id could not otherwise answer.
           */
          entityId: z.string().min(1).max(256),
          body: z.record(z.string(), z.unknown()),
        }),
        z.object({
          collection: z.string().min(1).max(128),
          op: z.literal('update'),
          entityId: z.string().min(1).max(256),
          body: z.record(z.string(), z.unknown()),
        }),
        z.object({
          collection: z.string().min(1).max(128),
          op: z.literal('delete'),
          entityId: z.string().min(1).max(256),
        }),
      ]),
    )
    .max(200)
    .default([]),
});
export type CodeHandlerResult = z.infer<typeof CodeHandlerResultSchema>;
