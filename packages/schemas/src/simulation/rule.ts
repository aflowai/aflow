import { z } from 'zod';
import { WorldPointerSchema, WorldTransitionSchema } from './worldEffect.js';

/**
 * One ordered match list per profile, first match wins.
 *
 * Fixtures and failure scenarios are the same rule: both match a resolved
 * request and produce a declared response, with a failure adding only an
 * ordinal and an optional world transition. Keeping them apart bought a second
 * authoring surface and a precedence order to explain.
 */

export const RuleArgMatchSchema = z.object({
  path: WorldPointerSchema,
  equals: z.union([z.string().max(2048), z.number(), z.boolean(), z.null()]),
});
export type RuleArgMatch = z.infer<typeof RuleArgMatchSchema>;

export const RuleMatchSchema = z.object({
  endpointId: z.string().min(1).max(128),
  args: z.array(RuleArgMatchSchema).max(8).optional(),
  /**
   * Which call to this endpoint the rule applies to, zero-based — the count of
   * this run's calls to it that have already COMMITTED. For a serialized run,
   * which is what an eval-grade run is, that is exact. For calls one turn
   * dispatched in parallel, "the third call" is a question about scheduling and
   * arrival order is the honest answer.
   */
  ordinal: z.number().int().min(0).max(1000).optional(),
  /** Requires an entity to be present (or absent) in the world before matching. */
  worldState: z
    .array(
      z.object({
        collection: z.string().min(1).max(128),
        exists: z.boolean(),
        identity: z.string().min(1).max(256).optional(),
      }),
    )
    .max(4)
    .optional(),
});
export type RuleMatch = z.infer<typeof RuleMatchSchema>;

export const RuleResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  body: z.unknown().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** Simulated latency. Bounded so a rule cannot stall a run. */
  delayMs: z.number().int().min(0).max(30_000).optional(),
});
export type RuleResponse = z.infer<typeof RuleResponseSchema>;

export const SimulationRuleSchema = z.object({
  ruleId: z.string().min(1).max(128),
  description: z.string().max(500).optional(),
  when: RuleMatchSchema,
  respond: RuleResponseSchema,
  /** World mutation applied atomically with the response, over its own reads. */
  transition: WorldTransitionSchema.optional(),
  /** Advances the virtual clock by this many milliseconds when the rule fires. */
  advanceClockMs: z.number().int().min(0).max(86_400_000).optional(),
});
export type SimulationRule = z.infer<typeof SimulationRuleSchema>;
