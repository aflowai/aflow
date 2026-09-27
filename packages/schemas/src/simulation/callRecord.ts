import { z } from 'zod';

/**
 * One durable record per simulated call — the journal entry, the idempotency
 * receipt, and the conformance corpus entry, all the same row.
 *
 * Deliberately per CALL and not per mutation: a pure `getOrder` and a
 * rule-driven 429 mutate nothing, and both belong to the corpus that
 * conformance replay and decision-time inspection read. A mutation-only
 * journal silently omits every read the agent made.
 *
 * Keyed on `logicalExecutionId` — `ExecutorContext.logicalExecutionId` names
 * the unit of work, stable across attempts, which is what makes the record
 * double as the receipt. Appending the record, claiming the key, and advancing
 * `worldVersionAfter` are ONE commit; the Redis head updates only after it
 * returns, or a replay could find a receipt for a mutation the journal never
 * recorded.
 */

/**
 * Which rung answered. `contract_example` was removed rather than deprecated:
 * it could only fire when the endpoint declared no success schema, which is
 * the same condition its own synthesizer throws on, so no call ever recorded
 * it in the executor.
 */
export const SimulationRungSchema = z.enum(['rule', 'code', 'world', 'generated']);
export type SimulationRung = z.infer<typeof SimulationRungSchema>;

export const SimulationCallRecordSchema = z.object({
  logicalExecutionId: z.string().min(1).max(256),
  simulationId: z.string().min(1).max(128),
  bindingId: z.string().min(1).max(128),
  apiId: z.string().min(1).max(128),
  endpointId: z.string().min(1).max(128),
  /** Canonical non-secret request shape — method, url, body. Never headers. */
  request: z.object({
    method: z.string().min(1).max(16),
    url: z.string().min(1).max(4096),
    body: z.unknown().optional(),
  }),
  matched: z.object({
    rung: SimulationRungSchema,
    ruleId: z.string().min(1).max(128).optional(),
  }),
  responseStatus: z.number().int().min(100).max(599),
  responseRef: z.string().min(1).max(512),
  /** Absent for a pure read — the record still exists. */
  deltaRef: z.string().min(1).max(512).optional(),
  ordinal: z.number().int().min(0),
  worldVersionBefore: z.number().int().min(0),
  worldVersionAfter: z.number().int().min(0),
  /** Virtual-clock instant this call observed, not wall-clock. */
  clockMs: z.number().int().min(0),
});
export type SimulationCallRecord = z.infer<typeof SimulationCallRecordSchema>;
