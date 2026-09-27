/**
 * Source shared by every handler, textually.
 *
 * A code handler is a function body in an isolate, so it can import nothing —
 * which means the alternative to prepending this is seven copies of the
 * envelope, the policy lookup and the date grammar, drifting apart one edit at
 * a time. It is prepended rather than duplicated, and it is the only place any
 * of those shapes is written.
 *
 * Everything here reads the world and the request. Nothing here decides
 * anything: a decision belongs to the rule it implements, in the handler that
 * owns that rule.
 */
export const CS_DESK_PRELUDE = `
var B = (request && request.body) || {};
var NOW_ISO = new Date(now).toISOString();

function rows(name) { return (world && world[name]) || []; }
function first(list) { return list.length > 0 ? list[0] : null; }

/** The acting customer. Persona scoping means the world holds only their row. */
function me() { return first(rows('customers')); }
function market() { var c = me(); return c ? c.market : null; }
function currency() { var c = me(); return c ? c.currency : 'SAR'; }

/**
 * An approved value, or null. Null is never a default — the caller turns it
 * into policy_unresolved, which is what stops an unapproved deadline becoming
 * an invented one.
 */
function policy(key) {
  var m = market(), exact = null, any = null;
  var list = rows('policies');
  for (var i = 0; i < list.length; i++) {
    if (list[i].policy_key !== key) continue;
    if (list[i].market === m) exact = list[i];
    else if (list[i].market === '*') any = list[i];
  }
  var row = exact || any;
  return row ? row.value : null;
}

function money(amount, cur) {
  return { amount: Math.round(amount * 100) / 100, currency: cur || currency() };
}

function envelope(status, result, extras) {
  var out = { status: status };
  if (result !== undefined && result !== null) out.result = result;
  var e = extras || {};
  if (e.escalations && e.escalations.length > 0) out.escalations = e.escalations;
  if (e.error_recovery) out.error_recovery = e.error_recovery;
  return { status: 200, body: out };
}

function recovery(code, message, opts) {
  var o = opts || {};
  var r = { code: code, message: message, retryable: o.retryable === true };
  if (o.retry_after_ms !== undefined) r.retry_after_ms = o.retry_after_ms;
  if (o.missing_fields) r.missing_fields = o.missing_fields;
  if (o.applied_scope) r.applied_scope = o.applied_scope;
  return r;
}

function escalation(reason, scope, detail) {
  return { reason: reason, scope: scope, detail: detail };
}

/** Section metadata. Every section carries it, including the complete ones. */
function meta(availability, opts) {
  var o = opts || {};
  return {
    availability: availability,
    as_of: o.as_of === undefined ? NOW_ISO : o.as_of,
    has_more: o.has_more === true,
    section_cursor: o.section_cursor === undefined ? null : o.section_cursor
  };
}

/** Every source whose state bears on one of these scopes. */
function sourcesFor(scopes) {
  return rows('source_health').filter(function (s) {
    var a = s.applies_to || [];
    for (var i = 0; i < a.length; i++) if (scopes.indexOf(a[i]) >= 0) return true;
    return false;
  });
}

function coverage(scopes) {
  var found = sourcesFor(scopes);
  var complete = true, recheck = null;
  var out = [];
  for (var i = 0; i < found.length; i++) {
    var s = found[i];
    if (s.state !== 'checked') complete = false;
    if (s.recheck_at && !recheck) recheck = s.recheck_at;
    out.push({ source_key: s.source_key, state: s.state, as_of: s.as_of || null });
  }
  return { complete_for_scope: complete, sources: out, recheck_at: recheck };
}

function worstSourceState(scopes) {
  var found = sourcesFor(scopes);
  var rank = { checked: 0, lagging: 1, not_covered: 2, failed: 3 };
  var worst = 'checked';
  for (var i = 0; i < found.length; i++) {
    if (rank[found[i].state] > rank[worst]) worst = found[i].state;
  }
  return worst;
}

/**
 * Cursors carry the identity they were minted for, so one presented by another
 * account is refused without its filters being echoed back.
 */
function encodeCursor(obj) {
  var s = JSON.stringify(obj), out = '';
  for (var i = 0; i < s.length; i++) {
    out += ('0' + s.charCodeAt(i).toString(16)).slice(-2);
  }
  return 'cs1_' + out;
}

function decodeCursor(c) {
  if (typeof c !== 'string' || c.indexOf('cs1_') !== 0) return null;
  var hex = c.slice(4), s = '';
  if (hex.length % 2 !== 0) return null;
  for (var i = 0; i < hex.length; i += 2) {
    var n = parseInt(hex.substr(i, 2), 16);
    if (isNaN(n)) return null;
    s += String.fromCharCode(n);
  }
  try { return JSON.parse(s); } catch (err) { return null; }
}

/** 'date', 'datetime', or null. A datetime without an offset is not a datetime. */
function dateKind(v) {
  if (typeof v !== 'string') return null;
  if (/^\\d{4}-\\d{2}-\\d{2}$/.test(v)) return 'date';
  if (/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$/.test(v)) {
    return 'datetime';
  }
  return null;
}

/** A calendar date covers its whole day in the platform transaction timezone. */
function boundMs(value, kind, edge, tz) {
  if (kind === 'datetime') return Date.parse(value);
  var suffix = edge === 'end' ? 'T23:59:59.999' : 'T00:00:00.000';
  return Date.parse(value + suffix + tz);
}

function hoursBetween(fromIso, toMs) {
  var from = Date.parse(fromIso);
  if (isNaN(from)) return null;
  return (toMs - from) / 3600000;
}

function addHours(ms, hours) { return new Date(ms + hours * 3600000).toISOString(); }
function addDays(ms, days) { return new Date(ms + days * 86400000).toISOString(); }

/**
 * How a dated leg stands against its deadline. \`unknown\` when no approved
 * deadline covers it — never an estimate, and never a silent "on time".
 */
function timing(expectedByIso) {
  if (!expectedByIso) return 'unknown';
  var due = Date.parse(expectedByIso);
  if (isNaN(due)) return 'unknown';
  return now <= due ? 'within_window' : 'overdue';
}
`;
