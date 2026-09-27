import {
  envelope,
  ESCALATION_SCHEMA,
  HANDOVER_REASON_SCHEMA,
  MONEY_SCHEMA,
  PAGE_SCHEMA,
  SECTION_META_REQUIRED,
  SECTION_META_SCHEMA,
} from './envelope.js';

/**
 * The consumer-lending support desk — seven tools over refunds, orders,
 * payments, disputes and transfer to a human.
 *
 * Each tool is one POST carrying its input schema whole, rather than a set of
 * flat parameters, because three of the seven have a contract a parameter list
 * cannot state: `payments.search` is a window OR a cursor and never both,
 * `amount` is meaningless without `currency`, and every one of them refuses an
 * argument it does not declare. Those are enforced at call time by the same
 * body validator a live definition gets.
 *
 * Two fields the source specification carries are deliberately absent.
 * `suggested_next_actions` is not here because every one of the twenty-seven
 * rows that emits one is derivable from a fact the result already returns — a
 * required review from `escalations[]`, a linked read from the reference
 * itself, a further page from its cursor — and two encodings of one decision
 * can disagree. `allowed_actions` is not here because the surface has exactly
 * one mutation, so the field would restate `escalations[]` or be empty.
 */

const REFERENCE = { type: 'string', minLength: 1 } as const;
const NULLABLE_TIMESTAMP = { type: ['string', 'null'] } as const;

/** How a dated obligation stands against its approved deadline. */
const TIMING_STATE = {
  type: 'string',
  enum: ['within_window', 'overdue', 'unknown'],
  description:
    '`unknown` when no approved deadline covers this leg. It is never an estimate — a leg with no deadline in policy is reported as untimed rather than assumed on time.',
};

// ============================================================================
// 1. knowledge.search
// ============================================================================

const KNOWLEDGE_SEARCH_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['topic', 'question', 'language'],
  properties: {
    topic: {
      type: 'string',
      enum: [
        'refunds',
        'payment_reversals',
        'declined_orders',
        'purchase_limits',
        'prequalification',
      ],
    },
    question: { type: 'string', minLength: 1 },
    language: { type: 'string', enum: ['ar', 'en'] },
    product: { type: ['string', 'null'] },
  },
};

const KNOWLEDGE_SEARCH_RESULT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    guidance: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'body', 'source'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        conditions: { type: 'array', items: { type: 'string' } },
        source: {
          type: 'object',
          additionalProperties: false,
          required: ['article_id', 'version', 'effective_from'],
          properties: {
            article_id: { type: 'string' },
            version: { type: 'string' },
            effective_from: { type: 'string' },
          },
        },
        links: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'url'],
            properties: { label: { type: 'string' }, url: { type: 'string' } },
          },
        },
      },
    },
    missing_link: {
      type: 'object',
      additionalProperties: false,
      required: ['requested', 'approved_fallback'],
      properties: {
        requested: { type: 'string' },
        approved_fallback: { type: 'string' },
      },
      description:
        'KS-04. The guidance is verified and the app path it would normally carry is not approved for this market. The fallback is what to say instead; a route is never constructed.',
    },
    clarification: {
      type: 'object',
      additionalProperties: false,
      required: ['field', 'options'],
      properties: {
        field: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
      },
      description:
        'KS-02. Which fact is missing AND what it may be. Naming the field alone leaves the caller asking an open question the customer cannot answer, because only the content knows which products exist.',
    },
    uncovered_question: { type: 'string' },
    fallback: {
      type: 'object',
      additionalProperties: false,
      required: ['human_support', 'description'],
      properties: {
        human_support: { type: 'boolean' },
        description: { type: 'string' },
      },
    },
  },
};

// ============================================================================
// 2. orders.select
// ============================================================================

const ORDERS_SELECT_INPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    order_reference: { type: ['string', 'null'] },
    merchant_hint: { type: ['string', 'null'] },
    amount: { type: ['number', 'null'], minimum: 0 },
    currency: { type: ['string', 'null'], enum: ['SAR', 'AED', null] },
    occurred_from: { type: ['string', 'null'] },
    occurred_to: { type: ['string', 'null'] },
  },
  dependencies: { amount: ['currency'] },
  description:
    'Every field is optional; sending none opens the full eligible-order scope with its bounded defaults.',
};

const ORDER_CANDIDATE = {
  type: 'object',
  additionalProperties: false,
  required: ['order_ref', 'merchant_display_name', 'total', 'created_at', 'customer_safe_status'],
  properties: {
    order_ref: REFERENCE,
    merchant_display_name: { type: 'string' },
    total: MONEY_SCHEMA,
    created_at: { type: 'string' },
    customer_safe_status: { type: 'string' },
  },
};

const ORDERS_SELECT_RESULT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    selected_order_ref: { type: ['string', 'null'] },
    candidates: { type: 'array', items: ORDER_CANDIDATE },
    applied_filters: { type: 'object' },
    page: PAGE_SCHEMA,
    coverage: {
      type: 'object',
      additionalProperties: false,
      required: ['scope', 'complete'],
      properties: {
        scope: { type: 'string' },
        complete: { type: 'boolean' },
      },
    },
  },
};

// ============================================================================
// 3. order.inspect
// ============================================================================

const ORDER_INSPECT_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['order_ref'],
  properties: {
    order_ref: { type: 'string', minLength: 1 },
    section_cursor: { type: 'string', minLength: 1 },
  },
};

const REFUND_ALLOCATION = {
  type: 'object',
  additionalProperties: false,
  required: ['destination', 'amount', 'state', 'timing_state'],
  properties: {
    destination: { type: 'string', enum: ['plan', 'card', 'wallet', 'bank'] },
    amount: MONEY_SCHEMA,
    state: { type: 'string', enum: ['pending', 'processed', 'failed'] },
    processed_at: NULLABLE_TIMESTAMP,
    expected_by: NULLABLE_TIMESTAMP,
    timing_state: TIMING_STATE,
    trace_reference: { type: ['string', 'null'] },
  },
};

const REFUND_RECORD = {
  type: 'object',
  additionalProperties: false,
  required: ['refund_ref', 'state', 'owner', 'total', 'allocations'],
  properties: {
    refund_ref: REFERENCE,
    /**
     * The payment this refund settles against, when one is linked. OI-R8's
     * orphan external leg is resolvable only if this is here — it is the fact
     * that replaces a suggested `payment.inspect`.
     */
    payment_ref: { type: ['string', 'null'] },
    state: {
      type: 'string',
      enum: [
        'no_refund',
        'pending_merchant',
        'pending_tamara',
        'processed',
        'failed',
        'merchant_blocked',
      ],
    },
    owner: { type: 'string', enum: ['merchant', 'tamara', 'unknown'] },
    total: MONEY_SCHEMA,
    fees: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'amount'],
        properties: { label: { type: 'string' }, amount: MONEY_SCHEMA },
      },
    },
    allocations: { type: 'array', items: REFUND_ALLOCATION },
    expected_update_at: NULLABLE_TIMESTAMP,
    timing_state: TIMING_STATE,
    resulting_balance: MONEY_SCHEMA,
  },
};

const INSTALMENT = {
  type: 'object',
  additionalProperties: false,
  required: ['instalment_ref', 'due_date', 'amount', 'state'],
  properties: {
    instalment_ref: REFERENCE,
    due_date: { type: 'string' },
    amount: MONEY_SCHEMA,
    state: { type: 'string', enum: ['scheduled', 'paid', 'late', 'cancelled'] },
    payment_ref: { type: ['string', 'null'] },
  },
};

const ORDER_INSPECT_RESULT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    order: {
      type: 'object',
      additionalProperties: false,
      required: ['order_ref', 'merchant_display_name', 'total', 'lifecycle', 'created_at'],
      properties: {
        order_ref: REFERENCE,
        merchant_display_name: { type: 'string' },
        total: MONEY_SCHEMA,
        lifecycle: {
          type: 'string',
          enum: ['pending', 'active', 'completed', 'cancelled', 'declined', 'refunded'],
        },
        created_at: { type: 'string' },
      },
    },
    sections: {
      type: 'object',
      additionalProperties: false,
      properties: {
        plan: {
          type: 'object',
          additionalProperties: false,
          required: [...SECTION_META_REQUIRED],
          properties: {
            ...SECTION_META_SCHEMA,
            outstanding_balance: MONEY_SCHEMA,
            instalments: { type: 'array', items: INSTALMENT },
          },
        },
        refund: {
          type: 'object',
          additionalProperties: false,
          required: [...SECTION_META_REQUIRED],
          properties: {
            ...SECTION_META_SCHEMA,
            refunds: { type: 'array', items: REFUND_RECORD },
          },
        },
        decline: {
          type: 'object',
          additionalProperties: false,
          required: [...SECTION_META_REQUIRED],
          properties: {
            ...SECTION_META_SCHEMA,
            classification: { type: 'string', enum: ['explainable', 'technical', 'unknown'] },
            explanation: { type: 'string' },
            customer_actions: { type: 'array', items: { type: 'string' } },
            retry: {
              type: 'object',
              additionalProperties: false,
              required: ['state', 'condition_key', 'condition_satisfied'],
              properties: {
                state: { type: 'string', enum: ['permitted', 'blocked', 'conditional'] },
                condition_key: { type: ['string', 'null'] },
                condition_satisfied: { type: 'boolean' },
                eligible_at: NULLABLE_TIMESTAMP,
              },
            },
          },
        },
        claims: {
          type: 'object',
          additionalProperties: false,
          required: [...SECTION_META_REQUIRED],
          properties: {
            ...SECTION_META_SCHEMA,
            eligibility: {
              type: 'object',
              additionalProperties: false,
              required: ['state', 'reason'],
              properties: {
                state: { type: 'string', enum: ['eligible', 'ineligible', 'unknown'] },
                reason: { type: 'string' },
              },
            },
            existing: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['claim_ref', 'summary'],
                properties: { claim_ref: REFERENCE, summary: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
};

// ============================================================================
// 4. payments.search
// ============================================================================

const PAYMENTS_SEARCH_INPUT = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['occurred_from', 'occurred_to'],
      properties: {
        occurred_from: {
          type: 'string',
          description:
            'Start of the payment-attempt window. A date (YYYY-MM-DD) covers the whole calendar day in the platform transaction timezone; a datetime must carry an offset.',
        },
        occurred_to: {
          type: 'string',
          description:
            'Inclusive end, at the same precision as occurred_from. The same date twice is a one-day search.',
        },
        amount: {
          type: 'number',
          minimum: 0,
          description: 'Exact original-payment amount. Requires currency.',
        },
        currency: { type: 'string', enum: ['SAR', 'AED'] },
        last_four: {
          type: 'string',
          pattern: '^[0-9]{4}$',
          description:
            'Instrument discriminator only. It narrows a search and never establishes who is calling.',
        },
      },
      dependencies: { amount: ['currency'] },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['cursor'],
      properties: {
        cursor: {
          type: 'string',
          minLength: 1,
          description: 'Next page of the same search. Sent alone — it carries its own filters.',
        },
      },
    },
  ],
};

const PAYMENT_CANDIDATE = {
  type: 'object',
  additionalProperties: false,
  description:
    'A payment matching the search scope. A candidate establishes that the payment exists and when it was taken, and nothing about where the money now sits: whether it has been allocated against a plan, and whether that allocation is confirmed, are carried only by payment_inspect and are absent here by construction.',
  required: ['payment_ref', 'amount', 'currency', 'occurred_at'],
  properties: {
    payment_ref: REFERENCE,
    amount: { type: 'number' },
    currency: { type: 'string', enum: ['SAR', 'AED'] },
    occurred_at: { type: 'string' },
    customer_safe_descriptor: { type: ['string', 'null'] },
    payment_method_summary: { type: ['string', 'null'] },
    last_four: { type: ['string', 'null'] },
  },
};

const COVERAGE = {
  type: 'object',
  additionalProperties: false,
  required: ['complete_for_scope', 'sources', 'recheck_at'],
  properties: {
    complete_for_scope: { type: 'boolean' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source_key', 'state', 'as_of'],
        properties: {
          source_key: { type: 'string' },
          state: {
            type: 'string',
            // `conflict` is a source that answered and disagreed with another.
            // Reporting it as `checked` would hide the disagreement and
            // reporting it as `failed` would say nobody answered.
            enum: ['checked', 'lagging', 'failed', 'not_covered', 'conflict'],
          },
          as_of: NULLABLE_TIMESTAMP,
        },
      },
    },
    recheck_at: NULLABLE_TIMESTAMP,
  },
};

const PAYMENTS_SEARCH_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['query_executed'],
  properties: {
    query_executed: { type: 'boolean' },
    candidates: { type: 'array', items: PAYMENT_CANDIDATE },
    applied_scope: { type: 'object' },
    coverage: COVERAGE,
    page: PAGE_SCHEMA,
    evidence_requirements: {
      type: 'array',
      items: { type: 'string' },
      description:
        'What a human review would need from the customer. Returned on a complete no-match so the evidence is collected before a transfer, not after it.',
    },
    review_reasons: {
      type: 'array',
      items: HANDOVER_REASON_SCHEMA,
      description: 'The review routes this scoped result qualifies for.',
    },
  },
};

// ============================================================================
// 5. payment.inspect
// ============================================================================

const PAYMENT_INSPECT_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['payment_ref'],
  properties: {
    payment_ref: { type: 'string', minLength: 1 },
    section_cursor: { type: 'string', minLength: 1 },
  },
};

const PAYMENT_INSPECT_RESULT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    payment: {
      type: 'object',
      additionalProperties: false,
      required: ['payment_ref', 'amount', 'currency', 'occurred_at', 'state'],
      properties: {
        payment_ref: REFERENCE,
        amount: { type: 'number' },
        currency: { type: 'string', enum: ['SAR', 'AED'] },
        occurred_at: { type: 'string' },
        descriptor: { type: ['string', 'null'] },
        state: {
          type: 'string',
          enum: [
            'pending',
            'authorized',
            'captured',
            'declined',
            'reversed',
            'refunded',
            'unknown',
          ],
        },
        last_four: { type: ['string', 'null'] },
        payment_method_summary: { type: ['string', 'null'] },
      },
    },
    classification: {
      type: 'string',
      enum: [
        'reflected',
        'authorization_hold',
        'reversal',
        'duplicate_capture',
        'remediation_in_progress',
        'waiting_for_refresh',
        'eligible_for_wallet_refund',
        'captured_not_reflected',
        'declined_reversal_unconfirmed',
        'unknown',
      ],
      description:
        'The verified lifecycle reading. Absent when the evidence needed to classify was missing or in conflict — an unclassified payment is not an unknown one.',
    },
    sections: {
      type: 'object',
      additionalProperties: false,
      properties: {
        obligations: {
          type: 'object',
          additionalProperties: false,
          required: [...SECTION_META_REQUIRED],
          properties: {
            ...SECTION_META_SCHEMA,
            linked_obligations: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['obligation_ref', 'order_ref', 'applied_amount', 'state'],
                properties: {
                  obligation_ref: REFERENCE,
                  order_ref: REFERENCE,
                  applied_amount: MONEY_SCHEMA,
                  remaining_amount: MONEY_SCHEMA,
                  state: { type: 'string' },
                },
              },
            },
          },
        },
        refunds: {
          type: 'object',
          additionalProperties: false,
          required: [...SECTION_META_REQUIRED],
          properties: {
            ...SECTION_META_SCHEMA,
            refunds: { type: 'array', items: REFUND_RECORD },
          },
        },
        reconciliation: {
          type: 'object',
          additionalProperties: false,
          required: [...SECTION_META_REQUIRED],
          properties: {
            ...SECTION_META_SCHEMA,
            application_state: {
              type: 'string',
              enum: ['applied', 'not_applied', 'partially_applied', 'unassessable'],
            },
            supporting_references: { type: 'array', items: { type: 'string' } },
            coverage: COVERAGE,
            remediation: {
              type: ['object', 'null'],
              additionalProperties: false,
              required: ['state'],
              properties: {
                state: { type: 'string', enum: ['pending', 'completed', 'failed'] },
                amount: MONEY_SCHEMA,
                expected_by: NULLABLE_TIMESTAMP,
                reference: { type: ['string', 'null'] },
              },
              description:
                'A correction already in flight or already done. Its presence is what excludes proposing another one.',
            },
          },
        },
        bank_state: {
          type: 'object',
          additionalProperties: false,
          required: [...SECTION_META_REQUIRED],
          properties: {
            ...SECTION_META_SCHEMA,
            debit: { type: 'string', enum: ['confirmed', 'unknown'] },
            reversal: { type: 'string', enum: ['confirmed', 'pending', 'unknown'] },
            evidence_source: { type: ['string', 'null'] },
          },
        },
      },
    },
  },
};

// ============================================================================
// 6. claim.inspect
// ============================================================================

const CLAIM_INSPECT_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['claim_ref'],
  properties: { claim_ref: { type: 'string', minLength: 1 } },
};

const CLAIM_INSPECT_RESULT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    claim_ref: REFERENCE,
    state: {
      type: 'string',
      enum: ['open', 'under_review', 'waiting_customer', 'resolved', 'closed', 'unknown'],
    },
    summary: { type: 'string' },
    owner: { type: 'string', enum: ['merchant', 'tamara', 'scheme', 'unknown'] },
    required_party: { type: ['string', 'null'], enum: ['customer', 'merchant', 'tamara', null] },
    customer_action: { type: ['string', 'null'] },
    evidence_requirements: { type: 'array', items: { type: 'string' } },
    human_action_in_progress: { type: 'boolean' },
    expected_update_at: NULLABLE_TIMESTAMP,
    outcome: { type: ['string', 'null'] },
  },
};

// ============================================================================
// 7. handover.start
// ============================================================================

const HANDOVER_START_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['reason', 'customer_goal', 'summary', 'attempted_actions'],
  properties: {
    reason: HANDOVER_REASON_SCHEMA,
    customer_goal: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
    order_refs: { type: 'array', items: { type: 'string' } },
    payment_refs: { type: 'array', items: { type: 'string' } },
    claim_refs: { type: 'array', items: { type: 'string' } },
    attempted_actions: { type: 'array', items: { type: 'string' } },
    evidence_refs: { type: 'array', items: { type: 'string' } },
    customer_confirmed: {
      type: 'boolean',
      description:
        'Whether the customer has agreed to be transferred. A route requiring confirmation returns `confirmation_required` until this is true.',
    },
    idempotency_key: {
      type: 'string',
      minLength: 1,
      description:
        'Scope for duplicate suppression. A second call in the same scope returns the case that already exists rather than opening another.',
    },
  },
};

const HANDOVER_START_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['case_ref', 'automation_locked'],
  properties: {
    case_ref: { type: ['string', 'null'] },
    queue: { type: ['string', 'null'] },
    customer_next_step: { type: 'string' },
    automation_locked: {
      type: 'boolean',
      description:
        'True once the case is with a human. The transfer that actually happened, not the one that was asked for.',
    },
    evidence: {
      type: 'object',
      additionalProperties: false,
      required: ['state'],
      properties: {
        state: {
          type: 'string',
          enum: ['not_required', 'pending', 'attached', 'partial', 'failed'],
        },
        accepted_refs: { type: 'array', items: { type: 'string' } },
        missing_types: { type: 'array', items: { type: 'string' } },
      },
    },
    reopens_at: NULLABLE_TIMESTAMP,
  },
};

// ============================================================================
// The definition
// ============================================================================

/**
 * One body parameter carrying the tool's whole input contract.
 *
 * Named `body`, and that is not cosmetic. A single body parameter is the WHOLE
 * body to the schema derivation the agent's tool spec and the call-time
 * validator both read, and a FIELD of the body to the executor's extraction —
 * so a caller sending `{ <paramName>: {...} }` gets it wrapped one level deeper
 * than the schema it is then checked against, and fails on required fields it
 * did send. Calling the parameter `body` collapses the two readings onto one
 * spelling, which is the only one every caller already uses.
 */
function body(schema: Record<string, unknown>): Array<Record<string, unknown>> {
  return [{ name: 'body', location: 'body', required: true, schema }];
}

export const CS_DESK_API_ID = 'cs-desk';

export const CS_DESK_ENDPOINTS = [
  {
    endpointId: 'knowledge_search',
    name: 'Search approved guidance',
    method: 'POST',
    pathTemplate: '/knowledge/search',
    writeRiskTier: 'read',
    description:
      'Approved guidance and product links for policy, timelines and general questions. For purchase-limit and pre-qualification questions it carries the app path. Transaction-specific facts come from order or payment inspection, never from here — this returns what the policy says, not what happened on an account.',
    params: body(KNOWLEDGE_SEARCH_INPUT),
    responseSchemas: envelope(
      // `partial` is KS-04: the guidance is verified and the app path it would
      // normally carry is not approved here. It is a status rather than a field
      // on the result because the answer is incomplete, and "read the status
      // first" only works if the status says so.
      ['answer_found', 'partial', 'clarification_required', 'no_approved_content', 'unavailable'],
      KNOWLEDGE_SEARCH_RESULT,
    ),
  },
  {
    endpointId: 'orders_select',
    name: 'Find the order',
    method: 'POST',
    pathTemplate: '/orders/select',
    writeRiskTier: 'read',
    description:
      "Identify an order or checkout attempt among the customer's own. Send the filters you already know; send nothing to open the default eligible scope. A reference the customer supplied resolves directly and can be inspected without going through selection.",
    params: body(ORDERS_SELECT_INPUT),
    responseSchemas: envelope(
      ['selected', 'candidates', 'ambiguous', 'no_match', 'unavailable'],
      ORDERS_SELECT_RESULT,
    ),
  },
  {
    endpointId: 'order_inspect',
    name: 'Inspect an order',
    method: 'POST',
    pathTemplate: '/orders/inspect',
    writeRiskTier: 'read',
    description:
      "An order's state, payment plan, refunds, decline and existing claims. Sections are evaluated independently and each one says whether it is complete — a claims outage does not stop you answering a plan question. Read `status` first, then the section the customer asked about, then `escalations` for anything that requires a human.",
    params: body(ORDER_INSPECT_INPUT),
    responseSchemas: envelope(
      ['complete', 'partial', 'not_found', 'conflict', 'unavailable'],
      ORDER_INSPECT_RESULT,
    ),
  },
  {
    endpointId: 'payments_search',
    name: 'Find a payment attempt',
    method: 'POST',
    pathTemplate: '/payments/search',
    writeRiskTier: 'read',
    pagination: { style: 'cursor', cursorParam: 'cursor' },
    description:
      "The customer's payment attempts in a known window, narrowed by amount, currency or card last four. Returns paged summaries carrying reference, amount, time and card — and no lifecycle or allocation state whatsoever: whether a payment has been captured, and whether it has reached the customer's plan, are answerable only from `payment_inspect`, so a question about where the money now sits is not answered by finding the payment. A payment reference already in hand skips the search. In a refund conversation, search on the ORIGINAL payment's details. `no_match` on a complete scope and `unavailable` on a failed source are different answers and must not be reported the same way.",
    params: body(PAYMENTS_SEARCH_INPUT),
    responseSchemas: envelope(
      [
        'matches',
        'no_match',
        'awaiting_source_refresh',
        'conflict',
        'unavailable',
        'missing_input',
        'invalid_input',
        'verification_required',
        'cursor_expired',
      ],
      PAYMENTS_SEARCH_RESULT,
    ),
  },
  {
    endpointId: 'payment_inspect',
    name: 'Inspect a payment',
    method: 'POST',
    pathTemplate: '/payments/inspect',
    writeRiskTier: 'read',
    description:
      "An identified payment's lifecycle, allocation, refunds and reconciliation. Answer from the section the question is about. That a transaction exists does not establish that the customer authorised it — a denial of authorisation is the customer's statement and is carried as one.",
    params: body(PAYMENT_INSPECT_INPUT),
    responseSchemas: envelope(
      ['complete', 'partial', 'conflict', 'unavailable', 'not_found'],
      PAYMENT_INSPECT_RESULT,
    ),
  },
  {
    endpointId: 'claim_inspect',
    name: 'Inspect a dispute claim',
    method: 'POST',
    pathTemplate: '/claims/inspect',
    writeRiskTier: 'read',
    description:
      'An existing dispute claim: its state, who owns it, what is expected next and what the customer has to do. The reference comes from order inspection. A closed claim describes an outcome and says nothing about whether the customer accepts it.',
    params: body(CLAIM_INSPECT_INPUT),
    responseSchemas: envelope(
      ['found', 'partial', 'not_found', 'unavailable'],
      CLAIM_INSPECT_RESULT,
    ),
  },
  {
    endpointId: 'handover_start',
    name: 'Transfer to a human',
    method: 'POST',
    pathTemplate: '/handover/start',
    writeRiskTier: 'low',
    description:
      'Transfer the case to human support. Use the `reason` an inspection returned in `escalations[]`; use `customer_requested_human` when the customer asks. Carry the goal, what was already attempted and every reference gathered. Report the state that came back — a transfer that returned `confirmation_required` or `out_of_hours` has not happened.',
    params: body(HANDOVER_START_INPUT),
    responseSchemas: envelope(
      [
        'started',
        'already_active',
        'confirmation_required',
        'out_of_hours',
        'failed',
        'rejected',
        'unavailable',
      ],
      HANDOVER_START_RESULT,
    ),
  },
] as const;

export const CS_DESK_DEFINITION = {
  apiId: CS_DESK_API_ID,
  name: 'Customer support desk',
  description:
    'Consumer-lending support: refunds and cancellations, unrecognised and unrecorded charges, declined orders, purchase limits, and transfer to a human.',
  baseUrl: 'https://simulated.invalid',
  version: '0.1',
  callMode: 'endpoint',
  endpoints: CS_DESK_ENDPOINTS,
} as const;

export { ESCALATION_SCHEMA };
