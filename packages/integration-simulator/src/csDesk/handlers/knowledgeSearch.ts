/**
 * KS-01 … KS-05, in the specified order: dependency failure, then a missing
 * applicability fact, then applicable content, then no content.
 *
 * The order is the rule. A content service that did not answer must not fall
 * through to "no approved guidance" — one says the answer is unknown and the
 * other says it does not exist, and a customer told the wrong one is told
 * something false.
 */
export const KNOWLEDGE_SEARCH = `
// KS-01 — the content source could not be read. Never a no-content answer.
if (worstSourceState(['knowledge_search']) === 'failed') {
  var down = sourcesFor(['knowledge_search'])[0];
  return envelope('unavailable', null, {
    error_recovery: recovery(
      'source_unavailable',
      'The approved-content service did not answer, so whether guidance exists for this question is unknown.',
      {
        retryable: !down || down.retryable !== false,
        retry_after_ms: down && down.recheck_at
          ? Math.max(0, Date.parse(down.recheck_at) - now)
          : 60000
      }
    )
  });
}

var effective = rows('knowledge_articles').filter(function (a) {
  if (a.topic !== B.topic || a.market !== market() || a.language !== B.language) return false;
  if (a.effective_from && Date.parse(a.effective_from) > now) return false;
  if (a.effective_to && Date.parse(a.effective_to) <= now) return false;
  return true;
});

// KS-02 — several approved answers differ by product and the question named
// none, so the discriminator is asked for and nothing else is.
var productSpecific = effective.filter(function (a) { return !!a.product; });
// The discriminator is needed whenever approved content is product-specific
// and the question named no product — including when exactly one such article
// exists. Requiring two made a topic covered by a single product's guidance
// answer a general question with that product's policy, which is the
// confusion this rule exists to prevent.
if (!B.product && productSpecific.length > 0) {
  var options = [];
  for (var pi = 0; pi < productSpecific.length; pi++) {
    if (options.indexOf(productSpecific[pi].product) < 0) options.push(productSpecific[pi].product);
  }
  return envelope('clarification_required', { clarification: { field: 'product', options: options } }, {
    error_recovery: recovery(
      'missing_input',
      'More than one approved answer applies to this topic and they differ by product. Naming the product selects one.',
      { retryable: true, missing_fields: ['product'] }
    )
  });
}

var applicable = B.product
  ? effective.filter(function (a) { return !a.product || a.product === B.product; })
  : effective;

// A product-specific article outranks the general one for the same question.
applicable.sort(function (x, y) { return (y.product ? 1 : 0) - (x.product ? 1 : 0); });
var article = first(applicable);

// KS-05 — the lookup completed and nothing approved covers the question.
if (!article) {
  var fallback = policy('knowledge_fallback');
  var out = { uncovered_question: B.question };
  var escalations = [];
  if (fallback) {
    out.fallback = {
      human_support: fallback.human_support === true,
      description: fallback.description
    };
    if (fallback.human_support === true) {
      escalations.push(escalation(
        'customer_requested_human',
        'knowledge',
        'No approved guidance covers this question and the approved fallback for this market offers human support.'
      ));
    }
  }
  return envelope('no_approved_content', out, { escalations: escalations });
}

var guidance = {
  title: article.title,
  body: article.body,
  source: {
    article_id: article.article_id,
    version: article.version,
    effective_from: article.effective_from
  }
};
if (article.conditions && article.conditions.length > 0) guidance.conditions = article.conditions;
if (article.links && article.links.length > 0) guidance.links = article.links;

// KS-04 — verified guidance whose app path is not approved for this market.
// The fallback wording is returned; a route is never constructed.
if (article.missing_link_label) {
  return envelope('partial', {
    guidance: guidance,
    missing_link: {
      requested: article.missing_link_label,
      approved_fallback: article.missing_link_fallback || 'Direct the customer to the app home screen.'
    }
  });
}

// KS-03
return envelope('answer_found', { guidance: guidance });
`;
