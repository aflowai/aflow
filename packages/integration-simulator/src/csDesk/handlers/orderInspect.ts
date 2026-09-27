/**
 * OI-F1, OI-F2, OI-R1 … OI-R10, OI-D1 … OI-D4, OI-N1, OI-N2.
 *
 * Sections are assessed independently and each carries its own availability,
 * which is the whole design: a dispute service that did not answer must not
 * stop the payment plan being explained, and a plan that was read must not be
 * reported with the same confidence as one that was not.
 *
 * Every escalation the source tables would have emitted as a suggested
 * `handover.start` is returned here as a reason on the affected scope.
 */
export const ORDER_INSPECT = `
var order = first(rows('orders').filter(function (o) { return o.order_ref === B.order_ref; }));

// OI-F1 — an authorised reference that resolves to nothing. It describes this
// reference and no other order.
if (!order) {
  return envelope('not_found', null, {
    error_recovery: recovery(
      'not_found',
      'No order on this account carries the reference ' + B.order_ref + '. Confirm the reference with the customer, or open the order picker.',
      { retryable: false }
    )
  });
}

var cursor = B.section_cursor ? decodeCursor(B.section_cursor) : null;
if (B.section_cursor && (!cursor || cursor.r !== B.order_ref)) {
  return envelope('partial', null, {
    error_recovery: recovery(
      'invalid_cursor',
      'That section cursor was not issued for this order, so the page it names cannot be returned.',
      { retryable: false }
    )
  });
}

var escalations = [];
var recoveries = [];
var worstEnvelope = 'complete';
function degrade(level) {
  var rank = { complete: 0, partial: 1, conflict: 2 };
  if (rank[level] > rank[worstEnvelope]) worstEnvelope = level;
}

var sections = {};
var deadlines = policy('refund_deadlines');

// ---------------------------------------------------------------- plan
var planRows = rows('instalments')
  .filter(function (i) { return i.order_ref === order.order_ref; })
  .sort(function (x, y) { return Date.parse(x.due_date) - Date.parse(y.due_date); });

if (worstSourceState(['plan']) === 'failed') {
  sections.plan = meta('unavailable');
  degrade('partial');
  recoveries.push(recovery('source_unavailable', 'The payment plan could not be read.', { retryable: true }));
} else {
  var planSize = (policy('order_picker') || {}).page_size || 5;
  var offset = cursor && cursor.s === 'plan' ? cursor.o : 0;
  var slice = planRows.slice(offset, offset + planSize);
  var more = planRows.length > offset + planSize;
  var outstanding = 0;
  for (var pi = 0; pi < planRows.length; pi++) {
    if (planRows[pi].state === 'scheduled' || planRows[pi].state === 'late') {
      outstanding += planRows[pi].amount.amount;
    }
  }
  // OI-N2 — a bounded section says it has more and binds the cursor to this
  // order and this section, so a page cannot be replayed against another.
  var planSection = meta('complete', {
    has_more: more,
    section_cursor: more ? encodeCursor({ r: order.order_ref, s: 'plan', o: offset + planSize }) : null
  });
  planSection.outstanding_balance = money(outstanding, order.total.currency);
  planSection.instalments = slice.map(function (i) {
    return {
      instalment_ref: i.instalment_ref,
      due_date: i.due_date,
      amount: i.amount,
      state: i.state,
      payment_ref: i.payment_ref || null
    };
  });
  sections.plan = planSection;
}

// ---------------------------------------------------------------- claims
var claimsScope = order.claims_source_key ? [order.claims_source_key] : ['claims'];
var claimsReadable = worstSourceState(claimsScope) !== 'failed';
var orderClaims = claimsReadable
  ? rows('claims').filter(function (c) { return c.order_ref === order.order_ref; })
  : [];

if (!claimsReadable) {
  // OI-F2 — one section is unreadable and the rest of the answer stays usable.
  sections.claims = meta('unavailable');
  degrade('partial');
  recoveries.push(recovery(
    'source_unavailable',
    'The dispute service did not answer, so whether a claim exists for this order is unknown.',
    { retryable: true }
  ));
} else {
  var claimsSection = meta('complete');
  claimsSection.eligibility = {
    state: order.claim_eligibility || 'unknown',
    reason: order.claim_eligibility_reason || 'No eligibility assessment is recorded.'
  };
  claimsSection.existing = orderClaims.map(function (c) {
    return { claim_ref: c.claim_ref, summary: c.summary || c.state };
  });
  sections.claims = claimsSection;
}

// ---------------------------------------------------------------- refund
if (worstSourceState(['refund']) === 'failed') {
  // OI-R1's boundary: a source that did not answer is never "no refund".
  sections.refund = meta('unavailable');
  degrade('partial');
  recoveries.push(recovery('source_unavailable', 'The settlement service did not answer.', { retryable: true }));
} else {
  var refundRows = rows('refunds').filter(function (r) { return r.order_ref === order.order_ref; });
  var refundAvailability = 'complete';
  var out = [];

  for (var ri = 0; ri < refundRows.length; ri++) {
    var r = refundRows[ri];
    var allocations = (r.allocations || []).map(function (a) {
      return {
        destination: a.destination,
        amount: a.amount,
        state: a.state,
        processed_at: a.processed_at || null,
        expected_by: null,
        timing_state: a.state === 'processed' ? 'within_window' : 'unknown',
        trace_reference: a.trace_reference || null
      };
    });
    var record = {
      refund_ref: r.refund_ref,
      payment_ref: r.payment_ref || null,
      state: r.state,
      owner: r.owner,
      total: r.total,
      allocations: allocations,
      expected_update_at: null,
      timing_state: 'unknown'
    };
    if (r.fees && r.fees.length > 0) record.fees = r.fees;
    if (r.resulting_balance) record.resulting_balance = r.resulting_balance;

    var pending = r.state === 'pending_merchant' || r.state === 'pending_tamara';
    if (pending) {
      var days = null;
      if (deadlines) {
        if (r.owner === 'merchant') days = deadlines.merchant_days;
        else if (r.owner === 'tamara') days = deadlines.tamara_days;
      }
      // OI-R4 — no approved deadline, or an owner nobody verified. The facts
      // still stand; the timing is reported as unknown rather than assumed.
      if (days === null || days === undefined) {
        refundAvailability = 'partial';
        recoveries.push(recovery(
          'policy_unresolved',
          r.owner === 'unknown'
            ? 'Nobody has verified who owns this refund, so no approved deadline applies to it.'
            : 'No approved deadline is published for this refund, so whether it is late cannot be stated.',
          { retryable: false }
        ));
      } else {
        var expected = addDays(Date.parse(r.requested_at), days);
        record.expected_update_at = expected;
        record.timing_state = timing(expected);
        // OI-R2 is this same shape inside the window and needs nothing more.
        if (record.timing_state === 'overdue') {
          if (r.investigation_required_when_overdue === true) {
            // OI-R3 — past the deadline AND policy requires investigation.
            escalations.push(escalation(
              'refund_failure',
              'refund',
              'Refund ' + r.refund_ref + ' has passed its approved ' + days + '-day window with the ' + r.owner + ' and policy requires investigation.'
            ));
          } else {
            // OI-R4 — past the deadline with no approved action for it. The
            // delay is reported; nobody is blamed for it and nothing is promised.
            refundAvailability = 'partial';
            recoveries.push(recovery(
              'policy_unresolved',
              'This refund is past its approved window and no approved action for that is published, so what happens next cannot be stated.',
              { retryable: false }
            ));
          }
        }
      }
    }

    if (r.state === 'processed') {
      var orphan = false;
      for (var ai = 0; ai < (r.allocations || []).length; ai++) {
        if (r.allocations[ai].reconciled === false) orphan = true;
      }
      // OI-R8 — the source records an external settlement it cannot reconcile.
      // The linked payment reference IS the resolution path when there is one.
      if (orphan) {
        refundAvailability = 'partial';
        if (!record.payment_ref) {
          escalations.push(escalation(
            'conflicting_data',
            'refund',
            'Refund ' + r.refund_ref + ' records an external settlement that cannot be reconciled, and no linked payment can resolve it.'
          ));
        } else {
          recoveries.push(recovery(
            'source_unavailable',
            'One settlement leg of ' + r.refund_ref + ' has no reconciling record. The linked payment ' + record.payment_ref + ' carries the detail that would resolve it.',
            { retryable: false }
          ));
        }
      }
      // OI-R5 and OI-R6 both land here — a plan-only settlement and a split
      // one differ in their allocations and in nothing else.
    }

    // OI-R7 — a confirmed failed leg. Completed legs are preserved beside it.
    var anyFailed = r.state === 'failed';
    for (var fi = 0; fi < (r.allocations || []).length; fi++) {
      if (r.allocations[fi].state === 'failed') anyFailed = true;
    }
    if (anyFailed) {
      escalations.push(escalation(
        'refund_failure',
        'refund',
        'A settlement leg of ' + r.refund_ref + ' failed. Completed legs on the same refund are unaffected.'
      ));
    }

    if (r.state === 'merchant_blocked') {
      if (orderClaims.length > 0) {
        // OI-R9 — the existing claim is reused rather than a new one opened.
        // Its reference is in the claims section.
      } else if (!claimsReadable) {
        // A claim service that did not answer does not establish that no claim
        // exists, so this is not OI-R10.
        refundAvailability = 'partial';
      } else {
        // OI-R10 — verified block, complete coverage, no claim anywhere.
        escalations.push(escalation(
          'merchant_blocked_refund',
          'refund',
          'The merchant has blocked refund ' + r.refund_ref + ' and no dispute claim exists for this order.'
        ));
      }
    }

    out.push(record);
  }

  var refundSection = meta(refundAvailability);
  refundSection.refunds = out;
  sections.refund = refundSection;
  if (refundAvailability !== 'complete') degrade(refundAvailability);
}

// ---------------------------------------------------------------- decline
if (order.lifecycle === 'declined') {
  if (worstSourceState(['decline_codes']) === 'failed') {
    // OI-D4's boundary: a mapping service that did not answer is not an
    // unmapped code, and only one of those needs a human.
    sections.decline = meta('unavailable');
    degrade('partial');
    recoveries.push(recovery(
      'source_unavailable',
      'The decline-code mapping could not be read, so why this order was declined is unknown.',
      { retryable: true }
    ));
  } else {
    var mapping = first(rows('decline_codes').filter(function (d) { return d.code === order.decline_code; }));
    var declineSection = meta('complete');
    if (!mapping) {
      // OI-D4 — a reliable decline event with no approved mapping.
      declineSection.classification = 'unknown';
      declineSection.explanation = 'This checkout was not completed and the reason it carries has no approved explanation, so it needs to be looked at.';
      declineSection.customer_actions = [];
      declineSection.retry = { state: 'blocked', condition_key: null, condition_satisfied: false, eligible_at: null };
      escalations.push(escalation(
        'unknown_decline_code',
        'decline',
        'Order ' + order.order_ref + ' was declined with a code that has no approved mapping.'
      ));
    } else {
      declineSection.classification = mapping.classification;
      declineSection.explanation = mapping.explanation;
      declineSection.customer_actions = mapping.customer_actions || [];

      var satisfied = false;
      var eligibleAt = null;
      if (mapping.retry_after_hours !== null && mapping.retry_after_hours !== undefined && order.decline_last_at) {
        eligibleAt = addHours(Date.parse(order.decline_last_at), mapping.retry_after_hours);
        satisfied = now >= Date.parse(eligibleAt);
      }
      declineSection.retry = {
        state: mapping.retry_state || 'blocked',
        condition_key: mapping.retry_condition_key || null,
        condition_satisfied: satisfied,
        eligible_at: eligibleAt
      };

      // OI-D3 — the approved escalation condition is satisfied. Below the
      // threshold this is OI-D2 and produces no escalation at all; an
      // explainable code (OI-D1) never reaches it, and a final credit decision
      // promises no override.
      var threshold = mapping.escalation_recurrence;
      if (
        mapping.classification === 'technical' &&
        threshold !== null && threshold !== undefined &&
        (order.decline_recurrence || 0) >= threshold
      ) {
        escalations.push(escalation(
          mapping.escalation_reason || 'technical_investigation',
          'decline',
          'This decline has recurred ' + (order.decline_recurrence || 0) + ' times, at or above the approved threshold of ' + threshold + '.'
        ));
      }
    }
    sections.decline = declineSection;
  }
}

var result = {
  order: {
    order_ref: order.order_ref,
    merchant_display_name: order.merchant_display_name,
    total: order.total,
    lifecycle: order.lifecycle,
    created_at: order.created_at
  },
  sections: sections
};

return envelope(worstEnvelope === 'complete' ? 'complete' : worstEnvelope, result, {
  escalations: escalations,
  error_recovery: recoveries.length > 0 ? recoveries[0] : null
});
`;
