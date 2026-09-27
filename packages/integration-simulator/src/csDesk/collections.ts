/**
 * The world the desk answers from.
 *
 * Four kinds of collection, and the split is the design. The customer's own
 * records are `persona_scoped`, so a read is narrowed to the caller before any
 * handler sees it and no argument can widen it. Approved content and source
 * health are `shared`, because an article and an outage belong to nobody.
 *
 * And POLICY is a collection rather than a constant. Every number the source
 * specification leaves open — a refund deadline, a retry threshold, a page cap,
 * the hours a queue is staffed — is a row here, which buys two things a
 * constant cannot. An operator changes a deadline without a deploy, and the
 * specification's own rule that an unapproved mapping must return
 * `policy_unresolved` rather than a guess becomes something a test can make
 * true by deleting a row.
 */

const MONEY_FIELDS = {
  amount: { type: 'number' },
  currency: { type: 'string', enum: ['SAR', 'AED'] },
};

export const CS_DESK_COLLECTIONS = [
  {
    collection: 'customers',
    description: 'One row per identity a run may act as.',
    identityField: 'customer_id',
    ownership: 'persona_scoped',
    personaField: 'customer_id',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['customer_id', 'display_name', 'market', 'currency', 'verification_state'],
      properties: {
        customer_id: { type: 'string' },
        display_name: { type: 'string' },
        market: { type: 'string', enum: ['SA', 'AE'] },
        currency: { type: 'string', enum: ['SAR', 'AED'] },
        language: { type: 'string', enum: ['ar', 'en'] },
        /**
         * The assurance the platform has, not something a tool argument can
         * assert. `step_up_required` is what makes PS-02 and HS-02 reachable
         * without inventing a failure.
         */
        verification_state: {
          type: 'string',
          enum: ['verified', 'step_up_required', 'unverified'],
        },
      },
    },
  },
  {
    collection: 'orders',
    identityField: 'order_ref',
    ownership: 'persona_scoped',
    personaField: 'customer_id',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'order_ref',
        'customer_id',
        'merchant_display_name',
        'total',
        'lifecycle',
        'created_at',
      ],
      properties: {
        order_ref: { type: 'string' },
        customer_id: { type: 'string' },
        merchant_display_name: { type: 'string' },
        merchant_id: { type: 'string' },
        total: {
          type: 'object',
          additionalProperties: false,
          required: ['amount', 'currency'],
          properties: MONEY_FIELDS,
        },
        lifecycle: {
          type: 'string',
          enum: ['pending', 'active', 'completed', 'cancelled', 'declined', 'refunded'],
        },
        created_at: { type: 'string' },
        customer_safe_status: { type: 'string' },
        /** Set only on a declined order; joins to `decline_codes`. */
        decline_code: { type: ['string', 'null'] },
        /** How many times this decline has recurred, which is what OI-D2/D3 turn on. */
        decline_recurrence: { type: 'number' },
        decline_last_at: { type: ['string', 'null'] },
        claim_eligibility: { type: 'string', enum: ['eligible', 'ineligible', 'unknown'] },
        claim_eligibility_reason: { type: 'string' },
        /** Marks the order whose claims section is deliberately unreadable (OI-F2). */
        claims_source_key: { type: ['string', 'null'] },
      },
    },
  },
  {
    collection: 'instalments',
    identityField: 'instalment_ref',
    ownership: 'persona_scoped',
    personaField: 'customer_id',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['instalment_ref', 'customer_id', 'order_ref', 'due_date', 'amount', 'state'],
      properties: {
        instalment_ref: { type: 'string' },
        customer_id: { type: 'string' },
        order_ref: { type: 'string' },
        due_date: { type: 'string' },
        amount: {
          type: 'object',
          additionalProperties: false,
          required: ['amount', 'currency'],
          properties: MONEY_FIELDS,
        },
        state: { type: 'string', enum: ['scheduled', 'paid', 'late', 'cancelled'] },
        payment_ref: { type: ['string', 'null'] },
      },
    },
  },
  {
    collection: 'payments',
    identityField: 'payment_ref',
    ownership: 'persona_scoped',
    personaField: 'customer_id',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['payment_ref', 'customer_id', 'amount', 'currency', 'occurred_at', 'state'],
      properties: {
        payment_ref: { type: 'string' },
        customer_id: { type: 'string' },
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
        order_ref: { type: ['string', 'null'] },
        /** Where the money went on the ledger. `applied_amount` absent means it did not land. */
        applied_amount: { type: ['number', 'null'] },
        obligation_ref: { type: ['string', 'null'] },
        remaining_amount: { type: ['number', 'null'] },
        /**
         * A bank debit is a SEPARATE fact from a capture, and conflating the two
         * is the failure PI-11 exists to prevent — a declined attempt can still
         * show on a statement.
         */
        bank_debit: { type: 'string', enum: ['confirmed', 'unknown'] },
        bank_reversal: { type: 'string', enum: ['confirmed', 'pending', 'unknown'] },
        bank_evidence_source: { type: ['string', 'null'] },
        /** Names the row in `payments` this one duplicates the capture of. */
        duplicate_of: { type: ['string', 'null'] },
        /** A correction already in flight or done — its presence excludes a second one. */
        remediation: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['state'],
          properties: {
            state: { type: 'string', enum: ['pending', 'completed', 'failed'] },
            amount: {
              type: 'object',
              additionalProperties: false,
              required: ['amount', 'currency'],
              properties: MONEY_FIELDS,
            },
            expected_by: { type: ['string', 'null'] },
            reference: { type: ['string', 'null'] },
          },
        },
        /** Eligibility the market's own rules produced, never derived from a raw status. */
        wallet_refund_eligible: { type: ['boolean', 'null'] },
        wallet_refund_eligibility_ref: { type: ['string', 'null'] },
        /** Sources whose lag or failure affects THIS payment's assessment. */
        source_keys: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    collection: 'refunds',
    identityField: 'refund_ref',
    ownership: 'persona_scoped',
    personaField: 'customer_id',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['refund_ref', 'customer_id', 'order_ref', 'state', 'owner', 'total'],
      properties: {
        refund_ref: { type: 'string' },
        customer_id: { type: 'string' },
        order_ref: { type: 'string' },
        payment_ref: { type: ['string', 'null'] },
        state: {
          type: 'string',
          enum: ['pending_merchant', 'pending_tamara', 'processed', 'failed', 'merchant_blocked'],
        },
        owner: { type: 'string', enum: ['merchant', 'tamara', 'unknown'] },
        total: {
          type: 'object',
          additionalProperties: false,
          required: ['amount', 'currency'],
          properties: MONEY_FIELDS,
        },
        requested_at: { type: 'string' },
        fees: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'amount'],
            properties: {
              label: { type: 'string' },
              amount: {
                type: 'object',
                additionalProperties: false,
                required: ['amount', 'currency'],
                properties: MONEY_FIELDS,
              },
            },
          },
        },
        allocations: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['destination', 'amount', 'state'],
            properties: {
              destination: { type: 'string', enum: ['plan', 'card', 'wallet', 'bank'] },
              amount: {
                type: 'object',
                additionalProperties: false,
                required: ['amount', 'currency'],
                properties: MONEY_FIELDS,
              },
              state: { type: 'string', enum: ['pending', 'processed', 'failed'] },
              processed_at: { type: ['string', 'null'] },
              trace_reference: { type: ['string', 'null'] },
              /**
               * Set when the source records an external settlement whose amount
               * or linkage cannot be reconciled — OI-R8's orphan leg.
               */
              reconciled: { type: ['boolean', 'null'] },
            },
          },
        },
        resulting_balance: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['amount', 'currency'],
          properties: MONEY_FIELDS,
        },
        /** Whether policy explicitly requires investigation past the deadline (OI-R3). */
        investigation_required_when_overdue: { type: ['boolean', 'null'] },
      },
    },
  },
  {
    collection: 'claims',
    identityField: 'claim_ref',
    ownership: 'persona_scoped',
    personaField: 'customer_id',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['claim_ref', 'customer_id', 'state', 'owner'],
      properties: {
        claim_ref: { type: 'string' },
        customer_id: { type: 'string' },
        order_ref: { type: ['string', 'null'] },
        state: {
          type: 'string',
          enum: ['open', 'under_review', 'waiting_customer', 'resolved', 'closed', 'unknown'],
        },
        summary: { type: 'string' },
        owner: { type: 'string', enum: ['merchant', 'tamara', 'scheme', 'unknown'] },
        required_party: {
          type: ['string', 'null'],
          enum: ['customer', 'merchant', 'tamara', null],
        },
        customer_action: { type: ['string', 'null'] },
        evidence_requirements: { type: 'array', items: { type: 'string' } },
        human_action_in_progress: { type: 'boolean' },
        expected_update_at: { type: ['string', 'null'] },
        outcome: { type: ['string', 'null'] },
        /** The deadline policy key this claim is judged against (CI-06). */
        deadline_policy_key: { type: ['string', 'null'] },
      },
    },
  },
  {
    collection: 'handover_cases',
    description: 'Written by handover_start. The only mutation the desk makes.',
    identityField: 'case_ref',
    ownership: 'persona_scoped',
    personaField: 'customer_id',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['case_ref', 'customer_id', 'reason', 'state', 'created_at'],
      properties: {
        case_ref: { type: 'string' },
        customer_id: { type: 'string' },
        reason: { type: 'string' },
        queue: { type: ['string', 'null'] },
        state: { type: 'string', enum: ['active', 'closed'] },
        created_at: { type: 'string' },
        idempotency_key: { type: ['string', 'null'] },
        customer_goal: { type: 'string' },
        summary: { type: 'string' },
        order_refs: { type: 'array', items: { type: 'string' } },
        payment_refs: { type: 'array', items: { type: 'string' } },
        claim_refs: { type: 'array', items: { type: 'string' } },
        evidence_state: {
          type: 'string',
          enum: ['not_required', 'pending', 'attached', 'partial', 'failed'],
        },
        accepted_refs: { type: 'array', items: { type: 'string' } },
        missing_types: { type: 'array', items: { type: 'string' } },
        automation_locked: { type: 'boolean' },
      },
    },
  },
  {
    collection: 'knowledge_articles',
    description: 'Approved content. Shared, because guidance belongs to no customer.',
    identityField: 'article_id',
    ownership: 'shared',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['article_id', 'topic', 'market', 'language', 'title', 'body', 'version'],
      properties: {
        article_id: { type: 'string' },
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
        market: { type: 'string', enum: ['SA', 'AE'] },
        language: { type: 'string', enum: ['ar', 'en'] },
        title: { type: 'string' },
        body: { type: 'string' },
        conditions: { type: 'array', items: { type: 'string' } },
        version: { type: 'string' },
        effective_from: { type: 'string' },
        /** Past this instant the article is withdrawn and must not be selected. */
        effective_to: { type: ['string', 'null'] },
        links: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'url'],
            properties: { label: { type: 'string' }, url: { type: 'string' } },
          },
        },
        /**
         * The article answers only when the question names this product. Absent
         * means it applies whatever the customer holds — which is what makes
         * KS-02 a real branch rather than a guess.
         */
        product: { type: ['string', 'null'] },
        /** Whether the approved fallback for this topic offers a human (KS-05). */
        offers_human_support: { type: ['boolean', 'null'] },
        /** Named when the topic normally carries an app path this market lacks (KS-04). */
        missing_link_label: { type: ['string', 'null'] },
        missing_link_fallback: { type: ['string', 'null'] },
      },
    },
  },
  {
    collection: 'policies',
    description:
      'Every approved number and mapping. A key absent here is policy_unresolved, never a default.',
    identityField: 'policy_id',
    ownership: 'shared',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['policy_id', 'policy_key', 'market', 'value'],
      properties: {
        policy_id: { type: 'string' },
        policy_key: { type: 'string' },
        /** `*` applies to every market; a named market wins over it. */
        market: { type: 'string', enum: ['SA', 'AE', '*'] },
        value: { type: 'object' },
        version: { type: 'string' },
        effective_from: { type: 'string' },
      },
    },
  },
  {
    collection: 'decline_codes',
    description: 'The owned code-to-explanation map. A code absent here is OI-D4, not a guess.',
    identityField: 'code',
    ownership: 'shared',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'classification', 'explanation'],
      properties: {
        code: { type: 'string' },
        classification: { type: 'string', enum: ['explainable', 'technical'] },
        explanation: { type: 'string' },
        customer_actions: { type: 'array', items: { type: 'string' } },
        /** What must become true before a retry is worth making. */
        retry_condition_key: { type: ['string', 'null'] },
        retry_state: { type: 'string', enum: ['permitted', 'blocked', 'conditional'] },
        /** Recurrences at or above this permit escalation (OI-D3). Null never escalates. */
        escalation_recurrence: { type: ['number', 'null'] },
        escalation_reason: { type: ['string', 'null'] },
        /** Hours after the last attempt before a retry is eligible. */
        retry_after_hours: { type: ['number', 'null'] },
      },
    },
  },
  {
    collection: 'source_health',
    description:
      'Whether each upstream answered. This is what separates "no such record" from "could not look".',
    identityField: 'source_key',
    ownership: 'shared',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['source_key', 'state'],
      properties: {
        source_key: { type: 'string' },
        /**
         * `conflict` is a fifth state the response Coverage shape does not
         * carry, because a caller is told the assessment conflicts rather than
         * which pair of sources disagreed.
         */
        state: {
          type: 'string',
          enum: ['checked', 'lagging', 'failed', 'not_covered', 'conflict'],
        },
        as_of: { type: ['string', 'null'] },
        recheck_at: { type: ['string', 'null'] },
        retryable: { type: ['boolean', 'null'] },
        /** Endpoint ids and section names this source's state affects. */
        applies_to: { type: 'array', items: { type: 'string' } },
      },
    },
  },
] as const;
