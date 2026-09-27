/**
 * Normalized API error codes for the API executor.
 *
 * Provides structured errors with:
 * - code: stable machine-readable code
 * - message: user-safe description
 * - retryable: whether the caller should retry
 * - details: structured, redacted context
 */
import type { AflowError } from '@aflow/schemas';

export type ApiErrorCode =
  | 'API_DEFINITION_NOT_FOUND'
  | 'API_ENDPOINT_NOT_FOUND'
  | 'API_BINDING_NOT_FOUND'
  | 'API_CREDENTIALS_NOT_CONFIGURED'
  | 'API_FORBIDDEN'
  | 'API_AUTH_FAILED'
  | 'API_TIMEOUT'
  | 'API_DNS_BLOCKED'
  | 'API_SSRF_BLOCKED'
  | 'API_BINDING_EGRESS_BLOCKED'
  /**
   * Direct-URL host-binding matching:
   * the URL's host matched MULTIPLE tenant bindings at the same scope
   * level, so the runtime can't pick a binding's egress policy
   * unambiguously. Caller must pass `apiId + bindingId` explicitly to
   * disambiguate. Not retryable.
   */
  | 'API_AMBIGUOUS_BINDING'
  | 'API_RESPONSE_TOO_LARGE'
  | 'API_REQUEST_TOO_LARGE'
  /** api.http.download reached a non-2xx/3xx response, so no file was streamed to the destination. */
  | 'API_DOWNLOAD_FAILED'
  | 'API_BODY_SOURCE_NOT_FOUND'
  | 'API_NETWORK_ERROR'
  | 'API_PROVIDER_ERROR'
  | 'API_METHOD_NOT_ALLOWED'
  | 'API_REDIRECT_BLOCKED'
  | 'API_RESPONSE_SCHEMA_MISMATCH'
  /**
   * An endpoint declares a schema Ajv cannot compile — usually an OpenAPI
   * `$ref` stored without being inlined, pointing into a spec the definition
   * does not carry. Distinct from a body or response that VIOLATES its schema:
   * nothing was checked, and no caller can fix it by sending different bytes.
   */
  | 'API_ENDPOINT_SCHEMA_INVALID'
  /**
   * A declared response transform (endpoint responseTransformPresetId or an
   * explicit response.transformPresetId naming a text preset) failed to parse
   * the response body. Fail-loud by design — a silent raw-body fallback would
   * hand the agent the very format the transform exists to normalize away.
   */
  | 'API_RESPONSE_TRANSFORM_FAILED'
  /** The binding names a simulation the space does not hold, so nothing can answer its endpoints. */
  | 'API_SIMULATION_NOT_FOUND'
  | 'API_SIMULATION_BASELINE_NOT_FOUND'
  | 'API_SIMULATION_PERSONA_NOT_FOUND'
  /**
   * A write would have given a row to a persona other than the acting one, or
   * written to an owned collection while acting as nobody. Refused rather than
   * stamped, because moving a row to another owner is not a decision the
   * caller gets to make — a real API takes the owner from the credential.
   */
  | 'API_SIMULATION_PERSONA_WRITE_REFUSED'
  /** No rung answered and the simulation refuses to invent — a test result, not a fabrication. */
  | 'API_SIMULATION_UNMATCHED'
  /**
   * A simulated call produced something its own declared schema forbids —
   * a response outside the schema for its status class, or a world delta
   * outside the collection schema of the entity it stores. Fail-loud by
   * design: for a simulated call the schema IS the authority, so a response
   * is a shape the real API could never return, and a delta is state every
   * later read and projection would run against illegitimately.
   */
  | 'API_SIMULATION_CONTRACT_VIOLATION'
  /**
   * The artifact a run pinned is not the artifact about to answer: the frozen
   * snapshot no longer resolves, or the API definition's endpoint set was
   * edited after the pin was taken. Refused rather than answered — the request
   * was shaped against one contract and would be judged against another.
   */
  | 'API_SIMULATION_PIN_BROKEN'
  /**
   * The simulation's `policy.maxGeneratedCallsPerRun` is spent. Refused rather
   * than downgraded to the contract example: a scenario that quietly stops
   * generating answers plausibly and stops rehearsing anything.
   */
  | 'API_SIMULATION_GENERATION_LIMIT'
  /** Generation is the only rung left and the space has no model it can resolve. */
  | 'API_SIMULATION_GENERATION_UNAVAILABLE'
  | 'API_RATE_LIMITED';

export function apiError(
  code: ApiErrorCode,
  message: string,
  opts?: {
    retryable?: boolean;
    details?: Record<string, unknown>;
  },
): AflowError {
  const error: AflowError = {
    code,
    message,
    classification: classifyApiError(code),
    retryable: opts?.retryable ?? isRetryableByDefault(code),
    timestamp: new Date().toISOString(),
  };
  if (opts?.details !== undefined) {
    error.details = opts.details;
  }
  return error;
}

function classifyApiError(code: ApiErrorCode): AflowError['classification'] {
  switch (code) {
    case 'API_DEFINITION_NOT_FOUND':
    case 'API_ENDPOINT_NOT_FOUND':
    case 'API_BODY_SOURCE_NOT_FOUND':
      return 'not_found';
    case 'API_BINDING_NOT_FOUND':
    case 'API_CREDENTIALS_NOT_CONFIGURED':
    case 'API_BINDING_EGRESS_BLOCKED':
    case 'API_SIMULATION_NOT_FOUND':
    case 'API_SIMULATION_BASELINE_NOT_FOUND':
    case 'API_SIMULATION_PERSONA_NOT_FOUND':
    case 'API_SIMULATION_PIN_BROKEN':
    case 'API_SIMULATION_GENERATION_UNAVAILABLE':
    case 'API_ENDPOINT_SCHEMA_INVALID':
      return 'configuration';
    case 'API_METHOD_NOT_ALLOWED':
    case 'API_REQUEST_TOO_LARGE':
    case 'API_RESPONSE_SCHEMA_MISMATCH':
    case 'API_AMBIGUOUS_BINDING':
    case 'API_DOWNLOAD_FAILED':
    case 'API_SIMULATION_UNMATCHED':
      return 'validation';
    // `API_SIMULATION_PERSONA_WRITE_REFUSED` is permission rather than
    // validation so `toAgentToolError` maps it to retry:false — the request is
    // well-formed, the caller simply has no authority over that row, and
    // repeating it cannot acquire any.
    case 'API_FORBIDDEN':
    case 'API_SSRF_BLOCKED':
    case 'API_DNS_BLOCKED':
    case 'API_REDIRECT_BLOCKED':
    case 'API_SIMULATION_PERSONA_WRITE_REFUSED':
      return 'permission';
    case 'API_AUTH_FAILED':
    case 'API_PROVIDER_ERROR':
    case 'API_RESPONSE_TOO_LARGE':
    case 'API_RESPONSE_TRANSFORM_FAILED':
      return 'provider';
    case 'API_TIMEOUT':
      return 'timeout';
    case 'API_NETWORK_ERROR':
      return 'transient';
    case 'API_RATE_LIMITED':
      return 'rate_limit';
    case 'API_SIMULATION_GENERATION_LIMIT':
      return 'budget';
    case 'API_SIMULATION_CONTRACT_VIOLATION':
      return 'internal';
    default:
      return 'internal';
  }
}

function isRetryableByDefault(code: ApiErrorCode): boolean {
  switch (code) {
    case 'API_TIMEOUT':
    case 'API_NETWORK_ERROR':
    case 'API_RATE_LIMITED':
    case 'API_PROVIDER_ERROR':
      return true;
    case 'API_DEFINITION_NOT_FOUND':
    case 'API_ENDPOINT_NOT_FOUND':
    case 'API_BINDING_NOT_FOUND':
    case 'API_CREDENTIALS_NOT_CONFIGURED':
    case 'API_FORBIDDEN':
    case 'API_AUTH_FAILED':
    case 'API_DNS_BLOCKED':
    case 'API_SSRF_BLOCKED':
    case 'API_BINDING_EGRESS_BLOCKED':
    case 'API_RESPONSE_TOO_LARGE':
    case 'API_REQUEST_TOO_LARGE':
    case 'API_DOWNLOAD_FAILED':
    case 'API_BODY_SOURCE_NOT_FOUND':
    case 'API_METHOD_NOT_ALLOWED':
    case 'API_REDIRECT_BLOCKED':
    case 'API_RESPONSE_SCHEMA_MISMATCH':
    case 'API_ENDPOINT_SCHEMA_INVALID':
    case 'API_RESPONSE_TRANSFORM_FAILED':
    case 'API_AMBIGUOUS_BINDING':
    case 'API_SIMULATION_NOT_FOUND':
    case 'API_SIMULATION_BASELINE_NOT_FOUND':
    case 'API_SIMULATION_PERSONA_NOT_FOUND':
    case 'API_SIMULATION_PERSONA_WRITE_REFUSED':
    case 'API_SIMULATION_UNMATCHED':
    case 'API_SIMULATION_CONTRACT_VIOLATION':
    case 'API_SIMULATION_PIN_BROKEN':
    case 'API_SIMULATION_GENERATION_LIMIT':
    case 'API_SIMULATION_GENERATION_UNAVAILABLE':
      return false;
  }
}
