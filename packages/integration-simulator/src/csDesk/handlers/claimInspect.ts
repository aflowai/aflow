/**
 * CI-01 … CI-06. Evidence failure is evaluated before state, so a claim
 * service that did not answer is never reported as a claim that does not
 * exist.
 */
export const CLAIM_INSPECT = `
// CI-02 — the claim service failed, or the row it returned contradicts itself.
if (worstSourceState(['claim_inspect', 'claims']) === 'failed') {
  var down = sourcesFor(['claim_inspect', 'claims'])[0];
  return envelope('unavailable', null, {
    error_recovery: recovery(
      'source_unavailable',
      'The dispute service did not answer. Whether this claim exists, and what state it is in, is unknown.',
      { retryable: !down || down.retryable !== false }
    )
  });
}

var claim = first(rows('claims').filter(function (c) { return c.claim_ref === B.claim_ref; }));

// CI-01 — a completed lookup that resolved nothing. It says nothing about the
// customer's other cases.
if (!claim) {
  return envelope('not_found', null, {
    error_recovery: recovery(
      'not_found',
      'No claim on this account matches that reference. It says nothing about whether other support cases exist.',
      { retryable: false }
    )
  });
}

var result = {
  claim_ref: claim.claim_ref,
  state: claim.state,
  owner: claim.owner,
  human_action_in_progress: claim.human_action_in_progress === true,
  expected_update_at: claim.expected_update_at || null,
  outcome: claim.outcome || null,
  required_party: claim.required_party || null,
  customer_action: claim.customer_action || null
};
if (claim.summary) result.summary = claim.summary;
if (claim.evidence_requirements && claim.evidence_requirements.length > 0) {
  result.evidence_requirements = claim.evidence_requirements;
}

// CI-02 (second half) — an inconsistent state is reported as unknown rather
// than resolved into one of the states it might have been.
if (claim.state === 'unknown') {
  return envelope('partial', result, {
    error_recovery: recovery(
      'source_unavailable',
      'The dispute service returned a state this claim cannot be in, so its current state is unknown.',
      { retryable: true }
    )
  });
}

// CI-06 — an approved condition makes this claim overdue or human-only.
var escalations = [];
if (claim.deadline_policy_key) {
  var rule = policy(claim.deadline_policy_key);
  if (!rule) {
    return envelope('partial', result, {
      error_recovery: recovery(
        'policy_unresolved',
        'This claim is judged against an approved deadline that is not published for this market, so whether it is overdue cannot be stated.',
        { retryable: false }
      )
    });
  }
  var overdue = claim.expected_update_at
    ? now > Date.parse(claim.expected_update_at)
    : false;
  if (overdue && rule.escalation_reason) {
    escalations.push(escalation(
      rule.escalation_reason,
      'claim',
      'The approved update deadline for this claim has passed and policy requires human review.'
    ));
  }
}

// CI-03 / CI-04 / CI-05 all answer \`found\` — the state and required_party
// carry the difference, so nothing has to be re-derived from the status.
return envelope('found', result, { escalations: escalations });
`;
