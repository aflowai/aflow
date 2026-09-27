/**
 * PS-01 … PS-09. Prerequisites first, then usable candidates, then conflict or
 * failure, then evidenced lag, then a complete no-match. Pagination is additive.
 *
 * The order is what keeps four different answers from collapsing into "nothing
 * found": a scope that was never queried, a source that failed, a source known
 * to be behind, and a search that genuinely completed empty.
 */
export const PAYMENTS_SEARCH = `
var limits = policy('search_limits');
if (!limits) {
  return envelope('unavailable', { query_executed: false }, {
    error_recovery: recovery(
      'policy_unresolved',
      'No approved search window is published for this market, so a payment search cannot be bounded.',
      { retryable: false }
    )
  });
}

// PS-02 — assurance is a platform fact. A card fragment narrows a search and
// never establishes who is calling, so it cannot raise this.
var customer = me();
if (!customer) {
  return envelope('verification_required', { query_executed: false }, {
    error_recovery: recovery(
      'verification_required',
      'No authenticated account is attached to this conversation, so no payment can be disclosed.',
      { retryable: false }
    )
  });
}
if (customer.verification_state !== 'verified') {
  return envelope('verification_required', { query_executed: false }, {
    error_recovery: recovery(
      'verification_required',
      'This account needs identity verification before payment details can be discussed.',
      { retryable: false }
    )
  });
}

var scope = null;
var offset = 0;

if (B.cursor) {
  var decoded = decodeCursor(B.cursor);
  // PS-03 — a cursor from another account is refused without its filters being
  // echoed back, which is the only way the refusal discloses nothing.
  if (!decoded || decoded.c !== customer.customer_id) {
    return envelope('cursor_expired', { query_executed: false }, {
      error_recovery: recovery(
        'invalid_cursor',
        'That page token is not valid for this account. Run the search again with its original filters.',
        { retryable: false }
      )
    });
  }
  if (decoded.exp !== undefined && decoded.exp !== null && now > decoded.exp) {
    // Expired but authorised: the scope IS returned, because re-issuing the
    // original search is the only thing that fixes it and the caller no longer
    // holds the filters.
    return envelope('cursor_expired', { query_executed: false, applied_scope: decoded.f }, {
      error_recovery: recovery(
        'cursor_expired',
        'That page token has expired. Run the same search again with the scope returned here.',
        { retryable: true, applied_scope: decoded.f }
      )
    });
  }
  scope = decoded.f;
  offset = decoded.o || 0;
} else {
  var fromKind = dateKind(B.occurred_from);
  var toKind = dateKind(B.occurred_to);
  var missing = [];
  if (!fromKind) missing.push('occurred_from');
  if (!toKind) missing.push('occurred_to');
  // PS-01 — a window that was never usable. Nothing was queried and the answer
  // says so, so it is never read as "no payments exist".
  if (missing.length > 0) {
    return envelope('invalid_input', { query_executed: false }, {
      error_recovery: recovery(
        'invalid_input',
        'A window bound must be a calendar date (YYYY-MM-DD) or a datetime carrying an offset.',
        { retryable: true, missing_fields: missing }
      )
    });
  }
  if (fromKind !== toKind) {
    return envelope('invalid_input', { query_executed: false }, {
      error_recovery: recovery(
        'invalid_input',
        'Both window bounds must use the same precision: two dates, or two datetimes.',
        { retryable: true, missing_fields: ['occurred_from', 'occurred_to'] }
      )
    });
  }
  var tz = limits.timezone_offset || '+00:00';
  var fromMs = boundMs(B.occurred_from, fromKind, 'start', tz);
  var toMs = boundMs(B.occurred_to, toKind, 'end', tz);
  if (isNaN(fromMs) || isNaN(toMs)) {
    return envelope('invalid_input', { query_executed: false }, {
      error_recovery: recovery('invalid_input', 'A window bound could not be read as a time.', {
        retryable: true, missing_fields: ['occurred_from', 'occurred_to']
      })
    });
  }
  if (fromMs > toMs) {
    return envelope('invalid_input', { query_executed: false }, {
      error_recovery: recovery(
        'invalid_input',
        'The window ends before it starts.',
        { retryable: true, missing_fields: ['occurred_from', 'occurred_to'] }
      )
    });
  }
  var maxDays = limits.max_window_days || 90;
  if (toMs - fromMs > maxDays * 86400000) {
    return envelope('invalid_input', { query_executed: false }, {
      error_recovery: recovery(
        'invalid_input',
        'The approved maximum search window is ' + maxDays + ' days.',
        { retryable: true, missing_fields: ['occurred_from', 'occurred_to'] }
      )
    });
  }
  scope = { occurred_from: B.occurred_from, occurred_to: B.occurred_to, from_ms: fromMs, to_ms: toMs };
  if (B.amount !== undefined) { scope.amount = B.amount; scope.currency = B.currency; }
  if (B.last_four) scope.last_four = B.last_four;
}

var matched = rows('payments').filter(function (p) {
  var at = Date.parse(p.occurred_at);
  if (at < scope.from_ms || at > scope.to_ms) return false;
  if (scope.amount !== undefined && scope.amount !== null) {
    if (p.amount !== scope.amount) return false;
    if (scope.currency && p.currency !== scope.currency) return false;
  }
  if (scope.last_four && p.last_four !== scope.last_four) return false;
  return true;
});
matched.sort(function (x, y) { return Date.parse(y.occurred_at) - Date.parse(x.occurred_at); });

var cov = coverage(['payments_search']);
var publicScope = {
  occurred_from: scope.occurred_from,
  occurred_to: scope.occurred_to
};
if (scope.amount !== undefined && scope.amount !== null) {
  publicScope.amount = scope.amount;
  publicScope.currency = scope.currency;
}
if (scope.last_four) publicScope.last_four = scope.last_four;

// PS-04 / PS-09 — usable candidates answer, whatever the coverage says. The
// coverage rides along rather than being collapsed into the status, because it
// names WHICH source is behind and a status could not.
if (matched.length > 0) {
  var size = limits.page_size || 5;
  var page = matched.slice(offset, offset + size);
  var more = matched.length > offset + size;
  return envelope('matches', {
    query_executed: true,
    candidates: page.map(function (p) {
      return {
        payment_ref: p.payment_ref,
        amount: p.amount,
        currency: p.currency,
        occurred_at: p.occurred_at,
        customer_safe_descriptor: p.descriptor || null,
        payment_method_summary: p.payment_method_summary || null,
        last_four: p.last_four || null
      };
    }),
    applied_scope: publicScope,
    coverage: cov,
    page: {
      page_size: page.length,
      has_more: more,
      next_cursor: more
        ? encodeCursor({
            c: customer.customer_id,
            f: publicScope,
            o: offset + size,
            exp: now + (limits.cursor_ttl_ms || 900000)
          })
        : null
    }
  });
}

var worst = worstSourceState(['payments_search']);

// PS-05 — relevant sources disagree. A conflict never becomes a no-match.
var conflicting = sourcesFor(['payments_search']).filter(function (s) { return s.state === 'conflict'; });
if (conflicting.length > 0) {
  return envelope('conflict', { query_executed: true, applied_scope: publicScope, coverage: cov }, {
    escalations: [escalation(
      'conflicting_data',
      'payments',
      'The payment sources for this window disagree, so no candidate can be stated as this account\\'s.'
    )]
  });
}

// PS-06 — a source failed or does not cover the scope. Whether a payment
// exists is unknown, which is not the same as it not existing.
if (worst === 'failed' || worst === 'not_covered') {
  var broken = sourcesFor(['payments_search']).filter(function (s) {
    return s.state === 'failed' || s.state === 'not_covered';
  })[0];
  var retryable = broken ? broken.retryable !== false : false;
  var escalations = [];
  if (!retryable) {
    escalations.push(escalation(
      'capability_unavailable',
      'payments',
      'The payment record for this window cannot be retrieved automatically and needs a human to retrieve it.'
    ));
  }
  return envelope('unavailable', { query_executed: true, applied_scope: publicScope, coverage: cov }, {
    escalations: escalations,
    error_recovery: recovery(
      'source_unavailable',
      retryable
        ? 'A payment source did not answer. Whether a matching payment exists is unknown.'
        : 'This window is outside what the payment records cover, so it cannot be searched.',
      { retryable: retryable }
    )
  });
}

// PS-07 — the lag has to be evidenced and has to bear on THIS window.
if (worst === 'lagging') {
  return envelope('awaiting_source_refresh', {
    query_executed: true,
    applied_scope: publicScope,
    coverage: cov
  });
}

// PS-08 — the whole lookup completed with complete coverage and zero
// candidates. The same answer for a listing question and a reported debit;
// what differs is what the conversation does with it.
var routing = policy('handover_routing') || {};
var evidence = (routing.evidence_required || {}).unrecognized_charge_review || [];
return envelope('no_match', {
  query_executed: true,
  candidates: [],
  applied_scope: publicScope,
  coverage: cov,
  page: { page_size: 0, has_more: false, next_cursor: null },
  evidence_requirements: evidence,
  review_reasons: ['unrecognized_charge_review', 'payment_not_reflected']
});
`;
