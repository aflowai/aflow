import { z } from 'zod';

/**
 * Simulation readiness, recomputed at read and never stamped.
 *
 * Two ENDPOINT levels, because one flag would have to lie: a compiling
 * response schema lets a stateless rule or a contract example answer and says
 * nothing about whether the endpoint can traverse the world, and an OpenAPI
 * import supplies schemas while being structurally unable to supply a
 * `WorldEffect`. Collapsing those would advertise endpoints that fail on their
 * first stateful call.
 *
 * Eval readiness is NOT an endpoint property and lives in
 * `SimulationCaseReadiness` below.
 */
export const SimulationEndpointReadinessSchema = z.enum([
  'not_ready',
  'contract_ready',
  'world_ready',
]);
export type SimulationEndpointReadiness = z.infer<typeof SimulationEndpointReadinessSchema>;

export const SimulationDiagnosticCodeSchema = z.enum([
  'response_schema_missing',
  'response_schema_uncompilable',
  'effect_collection_unknown',
  'effect_uncompilable',
  'effect_projection_invalid',
  'rule_status_undeclared',
  'authored_body_off_contract',
  'collection_schema_uncompilable',
  'collection_unread',
]);
export type SimulationDiagnosticCode = z.infer<typeof SimulationDiagnosticCodeSchema>;

/**
 * Exported so a producer can trim to it rather than guess at it: these details
 * embed a JSON Schema validator's own wording, which on a deep schema is long
 * enough to fail the very report it is describing.
 */
export const MAX_DIAGNOSTIC_DETAIL = 1000;

export const SimulationDiagnosticSchema = z.object({
  code: SimulationDiagnosticCodeSchema,
  endpointId: z.string().min(1).max(128).optional(),
  ruleId: z.string().min(1).max(128).optional(),
  /** Set when the finding is about a collection rather than an endpoint. */
  collection: z.string().min(1).max(128).optional(),
  detail: z.string().max(MAX_DIAGNOSTIC_DETAIL),
});
export type SimulationDiagnostic = z.infer<typeof SimulationDiagnosticSchema>;

export const SimulationEndpointReportSchema = z.object({
  endpointId: z.string().min(1).max(128),
  readiness: SimulationEndpointReadinessSchema,
  /** Status classes the endpoint declares a response schema for. */
  declaredStatusClasses: z.array(z.string().max(8)).default([]),
  hasEffect: z.boolean(),
  diagnostics: z.array(SimulationDiagnosticSchema).default([]),
});
export type SimulationEndpointReport = z.infer<typeof SimulationEndpointReportSchema>;

/** The coverage view an authoring surface reads. */
export const SimulationReadinessReportSchema = z.object({
  simulationId: z.string().min(1).max(128),
  revision: z.number().int().min(1),
  endpoints: z.array(SimulationEndpointReportSchema).default([]),
  worldReadyCount: z.number().int().min(0),
  contractReadyCount: z.number().int().min(0),
  notReadyCount: z.number().int().min(0),
  diagnostics: z.array(SimulationDiagnosticSchema).default([]),
});
export type SimulationReadinessReport = z.infer<typeof SimulationReadinessReportSchema>;

/**
 * Whether a case can be graded — derived over the (simulation, eval case)
 * pair, never over an endpoint. Gradeability depends on the recorded call set,
 * the pinned rule profile, the run context, and the assertions attached to the
 * case; an endpoint knows none of those, so listing this beside the endpoint
 * levels would let one claim gradeability for cases it has never seen.
 */
export const SimulationCaseReadinessSchema = z.object({
  ready: z.boolean(),
  /** Every call the case makes lands on a ready endpoint. */
  allCallsOnReadyEndpoints: z.boolean(),
  /** No call in the recorded corpus resolved through generation. */
  noGenerativeGap: z.boolean(),
  profilePinned: z.boolean(),
  definitionPinned: z.boolean(),
  reasons: z.array(z.string().max(500)).default([]),
});
export type SimulationCaseReadiness = z.infer<typeof SimulationCaseReadinessSchema>;
