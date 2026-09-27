/**
 * The one envelope every cs-desk endpoint answers in.
 *
 * The desk returns HTTP 200 for every outcome it has an opinion about — a
 * missing order, an unresolved policy, a failed source — and puts the outcome
 * in `status`. Only a transport failure a rule injects reaches 4xx/5xx. That is
 * deliberate: `api.http.call` reports a 4xx as a SUCCEEDED step, so an agent
 * reading HTTP codes reads them from a place the platform does not put them.
 * One field, read first, every time.
 */

/**
 * The reasons a case can reach a human, shared by the escalation a read
 * reports and the `reason` handover.start takes.
 *
 * ONE enum, because the pair is how the desk works without suggested next
 * actions: a read states the reason a transfer is required and the caller
 * passes it back verbatim. Two enums would let a read name a reason the
 * transfer cannot accept.
 */
export const HANDOVER_REASONS = [
  'technical_investigation',
  'refund_failure',
  'merchant_blocked_refund',
  'identity_verification_failed',
  'unrecognized_charge_review',
  'payment_not_reflected',
  'fraud_risk_review',
  'unknown_decline_code',
  'customer_requested_human',
  'capability_unavailable',
  'conflicting_data',
] as const;

export const HANDOVER_REASON_SCHEMA = {
  type: 'string',
  enum: [...HANDOVER_REASONS],
} as const;

/** Typed recovery codes. `policy_unresolved` is the one that must never be guessed past. */
export const ERROR_CODES = [
  'missing_input',
  'invalid_input',
  'verification_required',
  'access_denied',
  'not_found',
  'source_unavailable',
  'policy_unresolved',
  'cursor_expired',
  'invalid_cursor',
  'transfer_state_unknown',
  'retry_budget_exhausted',
] as const;

export const MONEY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['amount', 'currency'],
  properties: {
    amount: { type: 'number' },
    currency: { type: 'string', enum: ['SAR', 'AED'] },
  },
};

export const PAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['page_size', 'has_more', 'next_cursor'],
  properties: {
    page_size: { type: 'integer', minimum: 0 },
    has_more: { type: 'boolean' },
    next_cursor: { type: ['string', 'null'] },
  },
};

/**
 * Availability, freshness and paging for one bounded detail list.
 *
 * Every section carries it, including the ones that came back whole, because
 * "this section is complete" and "this section was never read" are the
 * distinction the whole partial-answer design rests on.
 */
export const SECTION_META_SCHEMA = {
  availability: { type: 'string', enum: ['complete', 'partial', 'unavailable', 'conflict'] },
  as_of: { type: ['string', 'null'] },
  has_more: { type: 'boolean' },
  section_cursor: { type: ['string', 'null'] },
};

export const SECTION_META_REQUIRED = ['availability', 'as_of', 'has_more', 'section_cursor'];

/**
 * A required human review, stated as a fact rather than as a suggested call.
 *
 * This is what replaces every `suggested_next_actions: [handover.start]` row in
 * the decision tables. `reason` is the exact value handover.start takes, so the
 * caller passes it through rather than choosing between eleven; `scope` names
 * the assessment that requires it, which is what "escalation concerns the
 * affected issue" means when several sections were evaluated independently.
 */
export const ESCALATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reason', 'scope', 'detail'],
  properties: {
    reason: HANDOVER_REASON_SCHEMA,
    scope: {
      type: 'string',
      description: 'The assessment requiring review — e.g. "refund", "decline", "reconciliation".',
    },
    detail: { type: 'string' },
  },
};

/**
 * `applied_scope` rides the recovery because an expired cursor is the one
 * failure whose fix is re-issuing the ORIGINAL search, and the caller no longer
 * holds its filters.
 */
export const ERROR_RECOVERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message', 'retryable'],
  properties: {
    code: { type: 'string', enum: [...ERROR_CODES] },
    message: { type: 'string' },
    retryable: { type: 'boolean' },
    retry_after_ms: { type: 'integer', minimum: 0 },
    missing_fields: { type: 'array', items: { type: 'string' } },
    applied_scope: { type: 'object' },
  },
};

const TRANSPORT_ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
    retry_after: { type: 'number' },
  },
};

/**
 * Compose one endpoint's response schemas.
 *
 * `4xx`/`5xx` describe an injected transport failure, which is the only thing
 * that leaves the envelope. A status class a rule can return and the definition
 * does not declare is a readiness diagnostic, so both are always declared.
 */
export function envelope(
  statuses: readonly string[],
  result: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  return {
    '2xx': {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: {
        status: { type: 'string', enum: [...statuses] },
        result,
        escalations: { type: 'array', items: ESCALATION_SCHEMA },
        error_recovery: ERROR_RECOVERY_SCHEMA,
      },
    },
    '4xx': TRANSPORT_ERROR_SCHEMA,
    '5xx': TRANSPORT_ERROR_SCHEMA,
  };
}
