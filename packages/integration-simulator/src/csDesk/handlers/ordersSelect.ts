/**
 * OS-01 … OS-04.
 *
 * The picker is a screen in the product and a candidate list here, and the
 * difference is where the selection happens rather than what is returned: one
 * visible row alongside further pages is still not a selection, and neither
 * form is allowed to make it one.
 */
export const ORDERS_SELECT = `
// OS-01 — the resolver did not answer. Distinct from having no orders.
if (worstSourceState(['orders_select']) === 'failed') {
  var down = sourcesFor(['orders_select'])[0];
  return envelope('unavailable', null, {
    error_recovery: recovery(
      'source_unavailable',
      'The order service did not answer, so whether this account has a matching order is unknown.',
      { retryable: !down || down.retryable !== false }
    )
  });
}

var limits = policy('order_picker');
if (!limits) {
  return envelope('unavailable', null, {
    error_recovery: recovery(
      'policy_unresolved',
      'No approved default scope is published for this market, so the eligible-order list cannot be bounded.',
      { retryable: false }
    )
  });
}

var all = rows('orders');

// OS-02 — a reference the customer supplied. Persona scoping is what makes
// another account's reference resolve to nothing rather than to their order.
if (B.order_reference) {
  var hit = first(all.filter(function (o) { return o.order_ref === B.order_reference; }));
  if (hit) {
    return envelope('selected', {
      selected_order_ref: hit.order_ref,
      candidates: [{
        order_ref: hit.order_ref,
        merchant_display_name: hit.merchant_display_name,
        total: hit.total,
        created_at: hit.created_at,
        customer_safe_status: hit.customer_safe_status || hit.lifecycle
      }],
      applied_filters: { order_reference: B.order_reference },
      coverage: { scope: 'reference', complete: true },
      page: { page_size: 1, has_more: false, next_cursor: null }
    });
  }
  return envelope('no_match', {
    selected_order_ref: null,
    candidates: [],
    applied_filters: { order_reference: B.order_reference },
    coverage: { scope: 'reference', complete: true },
    page: { page_size: 0, has_more: false, next_cursor: null }
  }, {
    error_recovery: recovery(
      'not_found',
      'No order on this account carries that reference.',
      { retryable: false }
    )
  });
}

// OS-03 — a cursor this endpoint minted is a cursor it honours. Advertising
// next_cursor and then ignoring it returned page one forever, so anything past
// the first page was unreachable. Scoped to the account it was minted for, as
// payments.search does, so another account's token discloses nothing.
var offset = 0;
if (B.cursor) {
  var decoded = decodeCursor(B.cursor);
  if (!decoded || decoded.c !== (caller ? caller.personaId : null)) {
    return envelope('cursor_expired', { query_executed: false }, {
      error_recovery: recovery(
        'invalid_cursor',
        'That page token is not valid for this account. Run the search again with its original filters.',
        { retryable: false }
      )
    });
  }
  offset = decoded.o || 0;
}

var filters = {};
var scopeFrom = now - (limits.default_scope_days || 365) * 86400000;
var matched = all.filter(function (o) {
  var at = Date.parse(o.created_at);
  if (B.occurred_from) {
    if (at < Date.parse(B.occurred_from)) return false;
  } else if (at < scopeFrom) return false;
  if (B.occurred_to && at > Date.parse(B.occurred_to)) return false;
  if (B.merchant_hint) {
    var hint = String(B.merchant_hint).toLowerCase();
    if (String(o.merchant_display_name).toLowerCase().indexOf(hint) < 0) return false;
  }
  if (B.amount !== undefined && B.amount !== null) {
    if (o.total.amount !== B.amount) return false;
  }
  // Applied whether or not an amount came with it. Echoing a currency into
  // applied_filters without filtering on it claims a scope the list does not
  // have, and the caller reads that claim as narrowing.
  if (B.currency && o.total.currency !== B.currency) return false;
  return true;
});

if (B.merchant_hint) filters.merchant_hint = B.merchant_hint;
if (B.amount !== undefined && B.amount !== null) filters.amount = B.amount;
if (B.currency) filters.currency = B.currency;
if (B.occurred_from) filters.occurred_from = B.occurred_from;
if (B.occurred_to) filters.occurred_to = B.occurred_to;

var narrowed = Object.keys(filters).length > 0;
var scope = narrowed
  ? 'filtered'
  : 'eligible orders from the last ' + (limits.default_scope_days || 365) + ' days';

matched.sort(function (x, y) { return Date.parse(y.created_at) - Date.parse(x.created_at); });

// OS-04 — the lookup completed and matched nothing.
if (matched.length === 0) {
  return envelope('no_match', {
    selected_order_ref: null,
    candidates: [],
    applied_filters: filters,
    coverage: { scope: scope, complete: true },
    page: { page_size: 0, has_more: false, next_cursor: null }
  });
}

// OS-03 — candidates, never an automatic selection. A single visible row with
// further pages behind it is the case this exists to refuse.
var size = limits.page_size || 5;
var page = matched.slice(offset, offset + size);
var hasMore = matched.length > offset + size;
var result = {
  selected_order_ref: null,
  candidates: page.map(function (o) {
    return {
      order_ref: o.order_ref,
      merchant_display_name: o.merchant_display_name,
      total: o.total,
      created_at: o.created_at,
      customer_safe_status: o.customer_safe_status || o.lifecycle
    };
  }),
  applied_filters: filters,
  coverage: { scope: scope, complete: !hasMore },
  page: {
    page_size: page.length,
    has_more: hasMore,
    next_cursor: hasMore
      ? encodeCursor({ c: caller ? caller.personaId : null, f: filters, o: offset + size })
      : null
  }
};

return envelope(narrowed && matched.length > 1 ? 'ambiguous' : 'candidates', result);
`;
