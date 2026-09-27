import { z } from 'zod';

// ----------------------------------------------------------------------------
// Source attribution — where the bad value came from
// ----------------------------------------------------------------------------

const ContractErrorSourceBindingSchema = z.object({
  kind: z.literal('binding'),
  /** Local name on the consumer's resolved inputs (matches inputBindings[bindAs]). */
  bindAs: z.string().min(1).max(64),
  /** Resolved producer task ID — walked from the consumer's inputBindings[bindAs]. */
  producerTaskId: z.string().min(1).max(64),
  /** Optional output key (only meaningful for task_output bindings). */
  producerOutputKey: z.string().max(64).optional(),
});

const ContractErrorSourceProducerOutputSchema = z.object({
  kind: z.literal('producer-output'),
  /** The task whose own submitted output failed its declared output schema. */
  producerTaskId: z.string().min(1).max(64),
});

const ContractErrorSourcePlatformSchema = z.object({
  kind: z.literal('platform'),
});

export const ContractErrorSourceSchema = z.discriminatedUnion('kind', [
  ContractErrorSourceBindingSchema,
  ContractErrorSourceProducerOutputSchema,
  ContractErrorSourcePlatformSchema,
]);
export type ContractErrorSource = z.infer<typeof ContractErrorSourceSchema>;

// ----------------------------------------------------------------------------
// Issue detail — one failing path within the validated value
// ----------------------------------------------------------------------------

export const ContractIssueSchema = z.object({
  /** Path into the validated value (Zod-style — string keys + numeric indexes). */
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string().min(1).max(1500),
});
export type ContractIssue = z.infer<typeof ContractIssueSchema>;

// ----------------------------------------------------------------------------
// Routing key — §3.3 blame classes
// ----------------------------------------------------------------------------

export const ContractErrorBlameSchema = z.enum([
  /** Producer's submitted output failed its own declared output schema. */
  'producer-output',
  /**
   * Downstream validation node (or input-binding resolution) found that a
   * specific producer's output violates a contract the producer could
   * reasonably know about.
   */
  'producer-contract',
  /**
   * Consumer's binding references a non-existent producer / outputKey / path.
   * Per D1 this MUST be caught at compose/assemble time; if it surfaces at
   * runtime, route as a platform-level error.
   */
  'consumer-binding',
  /** System error — db read failed, payload unavailable, etc. */
  'platform',
]);
export type ContractErrorBlame = z.infer<typeof ContractErrorBlameSchema>;

// ----------------------------------------------------------------------------
// ContractError — the typed error envelope emitted by lifecycle phases
// ----------------------------------------------------------------------------

export const ContractErrorCodeSchema = z.enum([
  'CONTRACT_INPUT_INVALID',
  'CONTRACT_OUTPUT_INVALID',
]);
export type ContractErrorCode = z.infer<typeof ContractErrorCodeSchema>;

/**
 * Common envelope fields shared by every blame class. Each variant of the
 * discriminated union below adds its own `blame` literal and constrains
 * `source` to the matching shape — so the §3.3 router can read e.g.
 * `source.bindAs` for `producer-contract` failures without runtime checks.
 */
const ContractErrorEnvelopeBase = {
  code: ContractErrorCodeSchema,
  /** Task whose lifecycle phase observed the failure. */
  consumerTaskId: z.string().min(1).max(64),
  /**
   * Which named input (for INPUT_INVALID) or output port (for OUTPUT_INVALID)
   * failed validation. For INPUT_INVALID this is the binding's `bindAs`
   * (matches `source.bindAs` when blame ∈ {producer-contract, consumer-binding});
   * for OUTPUT_INVALID it is the producer's `produces[*].key` or the literal
   * 'result' when validating against the whole output.
   */
  contractName: z.string().min(1).max(64),
  /** JSON Schema the value was expected to satisfy (for trace/debug). */
  expectedSchema: z.record(z.unknown()),
  /** Truncated preview of the actual value — clamped for readability. */
  actualValuePreview: z.unknown().optional(),
  /** Per-path issues; empty when the validator did not surface granular detail. */
  zodIssues: z.array(ContractIssueSchema).default([]),
} as const;

/**
 * `blame` is the routing key (§3.3). The discriminated union enforces that
 * `source` shape matches the blame class so the router can read attribution
 * fields (e.g. `source.bindAs` for binding-attributed blame) without runtime
 * type guards. Constructing a `producer-contract` error with a `platform`
 * source is a parser error, not a runtime crash later.
 */
export const ContractErrorSchema = z.discriminatedUnion('blame', [
  // producer-contract / consumer-binding — both walk the consumer's
  // inputBindings via source.bindAs, so they require source.kind 'binding'.
  z.object({
    blame: z.literal('producer-contract'),
    source: ContractErrorSourceBindingSchema,
    ...ContractErrorEnvelopeBase,
  }),
  z.object({
    blame: z.literal('consumer-binding'),
    source: ContractErrorSourceBindingSchema,
    ...ContractErrorEnvelopeBase,
  }),
  // producer-output — caught inside the producer's own validate_output;
  // the source identifies the producer task whose output failed its own schema.
  z.object({
    blame: z.literal('producer-output'),
    source: ContractErrorSourceProducerOutputSchema,
    ...ContractErrorEnvelopeBase,
  }),
  // platform — system error (db read failed, payload unavailable). No
  // attribution to either side; routes through the standard retry budget.
  z.object({
    blame: z.literal('platform'),
    source: ContractErrorSourcePlatformSchema,
    ...ContractErrorEnvelopeBase,
  }),
]);
export type ContractError = z.infer<typeof ContractErrorSchema>;
