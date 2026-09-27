/**
 * HS-01 … HS-08, in the specified order: validate the request and the session,
 * then check for a transfer that already exists, then confirmation, then
 * evidence, then the destination.
 *
 * The one thing every branch has in common is that it reports the transfer that
 * ACTUALLY happened. A request that was refused, queued, or left in an unknown
 * state has not transferred anybody, and saying otherwise is the failure this
 * whole tool is shaped to avoid.
 */
export const HANDOVER_START = `
var routing = policy('handover_routing');
if (!routing) {
  return envelope('unavailable', { case_ref: null, automation_locked: false }, {
    error_recovery: recovery(
      'policy_unresolved',
      'No approved queue mapping is published for this market, so a transfer cannot be routed.',
      { retryable: false }
    )
  });
}

var customer = me();

// HS-01 — every reference must belong to this account. Persona scoping means a
// reference from another account is simply not in the world, so this refuses
// rather than transferring somebody else's context.
var unknownRefs = [];
function checkRefs(list, collection, field) {
  for (var i = 0; i < (list || []).length; i++) {
    var wanted = list[i];
    var found = rows(collection).filter(function (r) { return r[field] === wanted; });
    if (found.length === 0) unknownRefs.push(wanted);
  }
}
if (customer) {
  checkRefs(B.order_refs, 'orders', 'order_ref');
  checkRefs(B.payment_refs, 'payments', 'payment_ref');
  checkRefs(B.claim_refs, 'claims', 'claim_ref');
}
if (unknownRefs.length > 0) {
  return envelope('rejected', { case_ref: null, automation_locked: false }, {
    error_recovery: recovery(
      'access_denied',
      'These references are not on this account and nothing about them was sent: ' + unknownRefs.join(', ') + '.',
      { retryable: false }
    )
  });
}

var queues = routing.queues || {};
var queue = queues[B.reason] || null;

// HS-02 — no authenticated account, or one the platform has not raised
// assurance on. The route carries the verification OUTCOME and no account
// detail, and never the answers to a challenge.
if (!customer) {
  return envelope('started', {
    case_ref: null,
    queue: 'secure_intake',
    automation_locked: true,
    customer_next_step: 'Continue in the secure channel, where identity can be established before any account detail is discussed.',
    evidence: { state: 'not_required' },
    reopens_at: null
  });
}
if (customer.verification_state !== 'verified') {
  var secureId = newId('handover_cases');
  return {
    status: 200,
    body: {
      status: 'started',
      result: {
        case_ref: secureId,
        queue: 'secure_intake',
        automation_locked: true,
        customer_next_step: 'Continue in the secure channel, where identity can be established before any account detail is discussed.',
        evidence: { state: 'not_required' },
        reopens_at: null
      }
    },
    mutations: [{
      collection: 'handover_cases',
      op: 'create',
      entityId: secureId,
      body: {
        case_ref: secureId,
        customer_id: customer.customer_id,
        reason: 'identity_verification_failed',
        queue: 'secure_intake',
        state: 'active',
        created_at: NOW_ISO,
        idempotency_key: B.idempotency_key || null,
        customer_goal: B.customer_goal,
        summary: B.summary,
        order_refs: [],
        payment_refs: [],
        claim_refs: [],
        evidence_state: 'not_required',
        accepted_refs: [],
        missing_types: [],
        automation_locked: true
      }
    }]
  };
}

// HS-03 — idempotency before initiating anything. A duplicate call reports the
// case that exists rather than opening a second one.
var active = rows('handover_cases').filter(function (c) {
  if (c.state !== 'active') return false;
  if (B.idempotency_key) return c.idempotency_key === B.idempotency_key;
  return true;
});
if (active.length > 0) {
  var existing = active[0];
  return envelope('already_active', {
    case_ref: existing.case_ref,
    queue: existing.queue || null,
    automation_locked: existing.automation_locked === true,
    customer_next_step: 'The team already has this case and will answer on it.',
    evidence: {
      state: existing.evidence_state || 'not_required',
      accepted_refs: existing.accepted_refs || [],
      missing_types: existing.missing_types || []
    },
    reopens_at: null
  });
}

// HS-04 — an optional suggestion is not a confirmation, and neither is asking.
var needsConfirmation = (routing.confirmation_required || []).indexOf(B.reason) >= 0;
if (needsConfirmation && B.customer_confirmed !== true) {
  return envelope('confirmation_required', {
    case_ref: null,
    queue: queue,
    automation_locked: false,
    customer_next_step: 'Ask the customer to confirm they want a person to take this over, then call again with customer_confirmed.',
    evidence: { state: 'not_required' },
    reopens_at: null
  });
}

// The evidence gate. Transport failure never becomes attached evidence, and
// partial evidence is reported as partial rather than rounded up.
var required = (routing.evidence_required || {})[B.reason] || [];
var supplied = B.evidence_refs || [];
var providedTypes = supplied.map(function (r) { return String(r).split(':')[0]; });
var missingTypes = required.filter(function (t) { return providedTypes.indexOf(t) < 0; });
if (missingTypes.length > 0) {
  return envelope('rejected', {
    case_ref: null,
    queue: queue,
    automation_locked: false,
    customer_next_step: 'Collect the evidence the review needs, then start the transfer again.',
    evidence: {
      state: supplied.length > 0 ? 'partial' : 'pending',
      accepted_refs: supplied,
      missing_types: missingTypes
    },
    reopens_at: null
  }, {
    error_recovery: recovery(
      'missing_input',
      'This review cannot be opened until the required evidence is attached.',
      { retryable: true, missing_fields: ['evidence_refs'] }
    )
  });
}

// HS-07 / HS-08 — the destination. A definitive rejection and a timeout are
// different answers: one says no transfer exists, the other says nobody knows.
var destination = worstSourceState(['handover_start']);
var destinationRow = sourcesFor(['handover_start'])[0];
if (destination === 'failed') {
  var retryable = destinationRow ? destinationRow.retryable !== false : false;
  return envelope('failed', {
    case_ref: null,
    queue: queue,
    automation_locked: false,
    customer_next_step: routing.out_of_hours_fallback || 'The team can be reached through the app.',
    evidence: { state: 'not_required', accepted_refs: supplied, missing_types: [] },
    reopens_at: null
  }, {
    error_recovery: recovery(
      'source_unavailable',
      retryable
        ? 'The transfer was refused and can be retried.'
        : 'The transfer was refused and the retry budget for this scope is spent.',
      { retryable: retryable }
    )
  });
}
if (destination === 'lagging') {
  return envelope('unavailable', {
    case_ref: null,
    queue: queue,
    automation_locked: false,
    customer_next_step: 'Do not start another transfer. The team reconciles this before anything is retried.',
    evidence: { state: 'not_required', accepted_refs: supplied, missing_types: [] },
    reopens_at: null
  }, {
    error_recovery: recovery(
      'transfer_state_unknown',
      'The transfer request timed out, so whether it reached the team is unknown. It is reconciled by its idempotency key before any retry.',
      { retryable: false }
    )
  });
}

// HS-05 — confirmation is satisfied and the destination is not staffed.
var offset = routing.timezone_offset_minutes || 0;
var localMinute = Math.floor((((now + offset * 60000) % 86400000) + 86400000) % 86400000 / 60000);
var open = routing.open_minute;
var close = routing.close_minute;
var staffed = open === undefined || close === undefined || (localMinute >= open && localMinute < close);

if (!staffed) {
  var untilOpen = localMinute < open ? open - localMinute : 1440 - localMinute + open;
  var reopensAt = addHours(now, untilOpen / 60);
  if (routing.out_of_hours_creates_case !== true) {
    return envelope('out_of_hours', {
      case_ref: null,
      queue: queue,
      automation_locked: false,
      customer_next_step: routing.out_of_hours_fallback || 'The team answers when the desk reopens.',
      evidence: { state: 'not_required', accepted_refs: supplied, missing_types: [] },
      reopens_at: reopensAt
    });
  }
  var queuedId = newId('handover_cases');
  return {
    status: 200,
    body: {
      status: 'out_of_hours',
      result: {
        case_ref: queuedId,
        queue: queue,
        automation_locked: false,
        customer_next_step: routing.out_of_hours_fallback || 'The team answers when the desk reopens.',
        evidence: {
          state: required.length > 0 ? 'attached' : 'not_required',
          accepted_refs: supplied,
          missing_types: []
        },
        reopens_at: reopensAt
      }
    },
    mutations: [{
      collection: 'handover_cases',
      op: 'create',
      entityId: queuedId,
      body: {
        case_ref: queuedId,
        customer_id: customer.customer_id,
        reason: B.reason,
        queue: queue,
        state: 'active',
        created_at: NOW_ISO,
        idempotency_key: B.idempotency_key || null,
        customer_goal: B.customer_goal,
        summary: B.summary,
        order_refs: B.order_refs || [],
        payment_refs: B.payment_refs || [],
        claim_refs: B.claim_refs || [],
        evidence_state: required.length > 0 ? 'attached' : 'not_required',
        accepted_refs: supplied,
        missing_types: [],
        automation_locked: false
      }
    }]
  };
}

// HS-06 — the destination accepted it. Automation is locked from here.
var caseId = newId('handover_cases');
return {
  status: 200,
  body: {
    status: 'started',
    result: {
      case_ref: caseId,
      queue: queue,
      automation_locked: true,
      customer_next_step: 'A member of the team has this now and answers here.',
      evidence: {
        state: required.length > 0 ? 'attached' : 'not_required',
        accepted_refs: supplied,
        missing_types: []
      },
      reopens_at: null
    }
  },
  mutations: [{
    collection: 'handover_cases',
    op: 'create',
    entityId: caseId,
    body: {
      case_ref: caseId,
      customer_id: customer.customer_id,
      reason: B.reason,
      queue: queue,
      state: 'active',
      created_at: NOW_ISO,
      idempotency_key: B.idempotency_key || null,
      customer_goal: B.customer_goal,
      summary: B.summary,
      order_refs: B.order_refs || [],
      payment_refs: B.payment_refs || [],
      claim_refs: B.claim_refs || [],
      evidence_state: required.length > 0 ? 'attached' : 'not_required',
      accepted_refs: supplied,
      missing_types: [],
      automation_locked: true
    }
  }]
};
`;
