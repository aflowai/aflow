/**
 * PI-F1, PI-01 … PI-11, PI-N1, PI-N2.
 *
 * Two precedences are load-bearing and neither is a first match. An existing
 * remediation excludes proposing another one, so PI-04 and PI-05 are tested
 * before PI-06 rather than beside it. And an authoritative market eligibility
 * (PI-08) answers before the generic unapplied-capture reading (PI-09), because
 * the two describe the same evidence and only one of them has a remedy.
 */
export const PAYMENT_INSPECT = `
var payment = first(rows('payments').filter(function (p) { return p.payment_ref === B.payment_ref; }));

// PI-F1 — an unresolved reference. Distinct from a reference this account may
// not read, which never reaches the world at all.
if (!payment) {
  return envelope('not_found', null, {
    error_recovery: recovery(
      'not_found',
      'No payment on this account carries the reference ' + B.payment_ref + '.',
      { retryable: false }
    )
  });
}

var scopes = ['payment_inspect', 'reconciliation'].concat(payment.source_keys || []);
var escalations = [];
var recoveries = [];
var worstEnvelope = 'complete';
function degrade(level) {
  var rank = { complete: 0, partial: 1, conflict: 2 };
  if (rank[level] > rank[worstEnvelope]) worstEnvelope = level;
}

var cov = coverage(scopes);
var sourceState = worstSourceState(scopes);
var sections = {};

// ------------------------------------------------------------- obligations
// PI-N1 — the linked order is named here, which is what makes a further read
// possible without anything having to suggest one.
var obligations = meta('complete');
obligations.linked_obligations = [];
if (payment.order_ref && payment.obligation_ref) {
  obligations.linked_obligations.push({
    obligation_ref: payment.obligation_ref,
    order_ref: payment.order_ref,
    applied_amount: money(payment.applied_amount || 0, payment.currency),
    remaining_amount: money(payment.remaining_amount || 0, payment.currency),
    state: payment.applied_amount ? 'applied' : 'not_applied'
  });
}
sections.obligations = obligations;

// ----------------------------------------------------------------- refunds
var linkedRefunds = rows('refunds').filter(function (r) { return r.payment_ref === payment.payment_ref; });
var refundSize = (policy('order_picker') || {}).page_size || 5;
var refundCursor = B.section_cursor ? decodeCursor(B.section_cursor) : null;
if (B.section_cursor && (!refundCursor || refundCursor.r !== payment.payment_ref)) {
  return envelope('partial', null, {
    error_recovery: recovery(
      'invalid_cursor',
      'That section cursor was not issued for this payment.',
      { retryable: false }
    )
  });
}
var refundOffset = refundCursor && refundCursor.s === 'refunds' ? refundCursor.o : 0;
var refundPage = linkedRefunds.slice(refundOffset, refundOffset + refundSize);
var refundsMore = linkedRefunds.length > refundOffset + refundSize;
var deadlines = policy('refund_deadlines');

// PI-N2 — the same bounded-section shape order inspection uses, bound to this
// payment rather than that order.
var refundsSection = meta('complete', {
  has_more: refundsMore,
  section_cursor: refundsMore
    ? encodeCursor({ r: payment.payment_ref, s: 'refunds', o: refundOffset + refundSize })
    : null
});
refundsSection.refunds = refundPage.map(function (r) {
  var expected = null;
  if (deadlines && r.requested_at) {
    var days = r.owner === 'merchant' ? deadlines.merchant_days : deadlines.tamara_days;
    if (days !== undefined && days !== null) expected = addDays(Date.parse(r.requested_at), days);
  }
  var record = {
    refund_ref: r.refund_ref,
    payment_ref: r.payment_ref || null,
    state: r.state,
    owner: r.owner,
    total: r.total,
    allocations: (r.allocations || []).map(function (a) {
      return {
        destination: a.destination,
        amount: a.amount,
        state: a.state,
        processed_at: a.processed_at || null,
        expected_by: expected,
        timing_state: a.state === 'processed' ? 'within_window' : timing(expected),
        trace_reference: a.trace_reference || null
      };
    }),
    expected_update_at: expected,
    timing_state: expected ? timing(expected) : 'unknown'
  };
  if (r.resulting_balance) record.resulting_balance = r.resulting_balance;
  return record;
});

// PI-10 — a failed leg, or one past an approved deadline. Completed legs on the
// same refund are retained beside it.
for (var li = 0; li < linkedRefunds.length; li++) {
  var lr = linkedRefunds[li];
  var failed = lr.state === 'failed';
  for (var la = 0; la < (lr.allocations || []).length; la++) {
    if (lr.allocations[la].state === 'failed') failed = true;
  }
  if (failed) {
    escalations.push(escalation(
      'refund_failure',
      'refund',
      'A settlement leg of ' + lr.refund_ref + ' failed and needs recovery. Completed legs are unaffected.'
    ));
  }
}
sections.refunds = refundsSection;

// -------------------------------------------------------------- bank_state
var bank = meta('complete');
bank.debit = payment.bank_debit || 'unknown';
bank.reversal = payment.bank_reversal || 'unknown';
bank.evidence_source = payment.bank_evidence_source || null;
sections.bank_state = bank;

// ---------------------------------------------------- classification
var classification = null;
var reconciliation = meta('complete');
reconciliation.coverage = cov;
reconciliation.supporting_references = [];
if (payment.obligation_ref) reconciliation.supporting_references.push(payment.obligation_ref);
reconciliation.remediation = payment.remediation || null;

var duplicate = !!payment.duplicate_of;
var remediation = payment.remediation || null;

if (sourceState === 'failed') {
  reconciliation.availability = 'unavailable';
  reconciliation.application_state = 'unassessable';
  degrade('partial');
  recoveries.push(recovery(
    'source_unavailable',
    'The ledger did not answer, so where this payment was applied is unknown.',
    { retryable: true }
  ));
} else if (payment.state === 'declined') {
  // PI-11 — declined does NOT imply the bank never took the money. Any verified
  // debit is preserved rather than explained away.
  classification = 'declined_reversal_unconfirmed';
  reconciliation.application_state = 'not_applied';
  if (payment.bank_reversal === 'confirmed') classification = 'reversal';
} else if (payment.state === 'reversed' || payment.bank_reversal === 'confirmed') {
  // PI-03 — a provider reversal is not a confirmed bank receipt, and the
  // bank_state section is where that difference stays visible.
  classification = 'reversal';
  reconciliation.application_state = 'not_applied';
} else if (payment.state === 'authorized' && (payment.applied_amount === null || payment.applied_amount === undefined)) {
  // PI-02 — a verified hold. An attempt alone would not have reached here.
  var hold = policy('authorization_hold');
  classification = 'authorization_hold';
  reconciliation.application_state = 'not_applied';
  if (!hold) {
    reconciliation.availability = 'partial';
    degrade('partial');
    recoveries.push(recovery(
      'policy_unresolved',
      'No approved hold window is published for this market, so when this hold releases cannot be stated.',
      { retryable: false }
    ));
  }
} else if (duplicate && remediation && remediation.state === 'completed') {
  // PI-04 — the correction is already done, so none is proposed.
  classification = 'duplicate_capture';
  reconciliation.application_state = 'not_applied';
} else if (duplicate && remediation && remediation.state === 'pending') {
  // PI-05 — a correction is in flight. Asking again does not open a second one.
  classification = 'remediation_in_progress';
  reconciliation.application_state = 'not_applied';
} else if (duplicate) {
  // PI-06 — a verified extra capture with no correction anywhere.
  classification = 'duplicate_capture';
  reconciliation.application_state = 'not_applied';
  escalations.push(escalation(
    'technical_investigation',
    'reconciliation',
    'This payment duplicates the capture of ' + payment.duplicate_of + ' and no correction exists for it.'
  ));
} else if (sourceState === 'lagging') {
  // PI-07 — the lag has to be evidenced against THIS payment. Being recent is
  // not evidence of anything.
  classification = 'waiting_for_refresh';
  reconciliation.availability = 'partial';
  reconciliation.application_state = 'unassessable';
  degrade('partial');
} else if (payment.applied_amount !== null && payment.applied_amount !== undefined) {
  // PI-01 — capture and application reconcile. A lagging search index elsewhere
  // does not hide a ledger application that was verified here.
  classification = 'reflected';
  reconciliation.application_state = 'applied';
} else if (payment.state === 'captured') {
  var wallet = policy('wallet_refund');
  var recon = policy('reconciliation');
  if (wallet && wallet.enabled === true && payment.wallet_refund_eligible === true) {
    // PI-08 — authoritative market eligibility, and no correction already open.
    classification = 'eligible_for_wallet_refund';
    reconciliation.application_state = 'not_applied';
    if (payment.wallet_refund_eligibility_ref) {
      reconciliation.supporting_references.push(payment.wallet_refund_eligibility_ref);
    }
    escalations.push(escalation(
      wallet.escalation_reason || 'payment_not_reflected',
      'reconciliation',
      'This payment is eligible for a wallet refund under the market rules and needs a human to issue it.'
    ));
  } else if (recon) {
    // PI-09 — captured, fresh and complete evidence, and it never landed.
    classification = 'captured_not_reflected';
    reconciliation.application_state = 'not_applied';
    escalations.push(escalation(
      recon.escalation_reason || 'technical_investigation',
      'reconciliation',
      'This payment was captured and never applied to an obligation.'
    ));
  } else {
    // The evidence is complete and the applicable correction policy is not
    // published, so the conclusion is withheld rather than guessed.
    reconciliation.availability = 'partial';
    reconciliation.application_state = 'unassessable';
    degrade('partial');
    recoveries.push(recovery(
      'policy_unresolved',
      'This payment was captured and not applied, and no approved correction for that is published in this market.',
      { retryable: false }
    ));
  }
} else {
  reconciliation.application_state = 'unassessable';
}

sections.reconciliation = reconciliation;

var result = {
  payment: {
    payment_ref: payment.payment_ref,
    amount: payment.amount,
    currency: payment.currency,
    occurred_at: payment.occurred_at,
    descriptor: payment.descriptor || null,
    state: payment.state,
    last_four: payment.last_four || null,
    payment_method_summary: payment.payment_method_summary || null
  },
  sections: sections
};
if (classification) result.classification = classification;

return envelope(worstEnvelope === 'complete' ? 'complete' : worstEnvelope, result, {
  escalations: escalations,
  error_recovery: recoveries.length > 0 ? recoveries[0] : null
});
`;
