import type { ConnectorCatalogEntry } from '@aflow/schemas';

/**
 * The reference simulated integration (Plan 293 §6): a support desk for a
 * buy-now-pay-later lender, with no lender behind it.
 *
 * It ships as a listing rather than a hidden fixture because it is the worked
 * example the plan is built around — install it and a space has twelve
 * endpoints an agent can call, answered from a world that is authored rather
 * than served. Nothing is authenticated and no world travels with it: installing
 * mints a simulation for the space, which answers by generation until
 * collections and effects are authored into it.
 *
 * The endpoint prose is written for the agent that will read it and carries the
 * domain's hard-won rules — never ask a customer for an order number, read the
 * status before the result, a refund is the merchant's money to return. This is
 * the definition the reference desk was graded against.
 */

/**
 * Every endpoint answers in one envelope, so the agent learns to read the
 * outcome before the payload: `status` first, `result` only when it is there.
 * Declared once and composed per endpoint — twelve copies of the same shape is
 * how a contract drifts.
 */
const STATUS_SCHEMA = {
  enum: ['success', 'partial', 'no_match', 'ambiguous', 'unavailable'],
  type: 'string',
  description:
    'The outcome. `partial` means some of the answer is missing and says which; `ambiguous` means the inputs matched several things and returns the candidates; `unavailable` means an upstream could not be reached and the answer is unknown rather than empty.',
};

const ERROR_SCHEMA = {
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: {
      type: 'string',
    },
    message: {
      type: 'string',
    },
    recovery: {
      type: 'string',
      description: 'What would make this call succeed, in terms the caller can act on.',
    },
  },
};

const NOT_OK_SCHEMA = {
  type: 'object',
  required: ['status', 'error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
        },
        message: {
          type: 'string',
        },
        recovery: {
          type: 'string',
        },
      },
    },
    status: {
      enum: ['no_match', 'unavailable'],
      type: 'string',
    },
  },
};

/** The envelope around one endpoint's own result shape. */
function envelope(result: Record<string, unknown>): Record<string, unknown> {
  return {
    '2xx': {
      type: 'object',
      required: ['status'],
      properties: { status: STATUS_SCHEMA, error: ERROR_SCHEMA, result },
    },
    '4xx': NOT_OK_SCHEMA,
  };
}

const ENDPOINTS = [
  {
    name: 'Search policy knowledge',
    tags: [],
    method: 'GET',
    params: [
      {
        name: 'query',
        schema: {
          type: 'string',
        },
        location: 'query',
        required: true,
      },
      {
        name: 'market',
        schema: {
          enum: ['SA', 'AE', 'KW'],
          type: 'string',
        },
        location: 'query',
        required: true,
      },
      {
        name: 'language',
        schema: {
          enum: ['ar', 'en'],
          type: 'string',
        },
        location: 'query',
        required: true,
      },
      {
        name: 'topic',
        schema: {
          type: 'string',
        },
        location: 'query',
        required: false,
        description:
          'Optional narrowing. Deliberately open rather than a fixed list — the base grows, and a list in this description would be wrong the first time someone writes an article. A search that finds nothing tells you what the topics are.',
      },
    ],
    endpointId: 'knowledgeSearch',
    description:
      'How the product works, what the rules are, and why things are the way they are — for a market, in the customer’s language. This is where an answer comes from whenever no other tool holds it: the other tools return this customer’s records, and everything else is here. Says nothing about this customer, so a question about their own situation needs a second call against their live state. A miss names the topics the base does cover.',
    pathTemplate: '/knowledge/search',
    responseSchemas: envelope({
      type: 'object',
      required: ['answer_facts', 'passages'],
      properties: {
        passages: {
          type: 'array',
          items: {
            type: 'object',
            required: ['text', 'source', 'effective_date'],
            properties: {
              text: {
                type: 'string',
                description: 'Customer-facing wording, in the requested language.',
              },
              source: {
                type: 'string',
              },
              effective_date: {
                type: 'string',
              },
              market_applicability: {
                type: 'array',
                items: {
                  type: 'string',
                },
                description:
                  'Markets this passage holds for. A passage for another market is not an answer.',
              },
            },
          },
        },
        answer_facts: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'The load-bearing facts, each stated on its own so one can be quoted.',
        },
      },
    }),
  },
  {
    name: 'Select an order',
    tags: [],
    method: 'GET',
    params: [
      {
        name: 'merchant_order_number',
        schema: {
          type: 'string',
        },
        location: 'query',
        required: false,
        description:
          'Only when the customer VOLUNTEERS a number. Never ask for one: a customer has a merchant confirmation, an app screen and a bank statement in front of them, all carrying different numbers, and asking which is which is the confusion this picker exists to remove.',
      },
      {
        name: 'merchant',
        schema: {
          type: 'string',
        },
        location: 'query',
        required: false,
        description: 'The shop, as the customer named it. Matched loosely.',
      },
      {
        name: 'order_date',
        schema: {
          type: 'string',
        },
        location: 'query',
        required: false,
        description: 'Whole or partial — "2026-07" matches anything that month.',
      },
      {
        name: 'amount',
        schema: {
          type: 'number',
        },
        location: 'query',
        required: false,
        description: 'What the customer says they paid.',
      },
      {
        name: 'order_status',
        schema: {
          type: 'string',
        },
        location: 'query',
        required: false,
        description:
          'Narrows to orders in one state — `overdue` when the customer says they are late, for instance.',
      },
      {
        name: 'payment_type',
        schema: {
          type: 'string',
        },
        location: 'query',
        required: false,
      },
    ],
    endpointId: 'ordersSelect',
    description:
      'The order picker: the customer’s own orders, presented so they can point at one. CALL THIS FIRST, with whatever the customer already said and nothing more — it is what makes asking them for an order number unnecessary, and they should never have to know one. Filters SCOPE the list, they do not resolve it: show what comes back and let the customer choose. It never dead-ends, so a filter that matches nothing still returns the full list.',
    pathTemplate: '/orders/select',
    responseSchemas: envelope({
      type: 'object',
      required: ['picker'],
      properties: {
        picker: {
          type: 'object',
          required: ['orders', 'total_orders', 'showing'],
          properties: {
            orders: {
              type: 'array',
              items: {
                type: 'object',
                required: [
                  'order_ref',
                  'merchant_name',
                  'order_date',
                  'amount',
                  'currency',
                  'order_status',
                ],
                properties: {
                  amount: {
                    type: 'number',
                  },
                  currency: {
                    type: 'string',
                  },
                  order_ref: {
                    type: 'string',
                    description:
                      'Opaque. Pass to order.inspect; never shown to the customer as an id.',
                  },
                  order_date: {
                    type: 'string',
                  },
                  order_status: {
                    enum: ['declined', 'active', 'overdue', 'settled', 'cancelled', 'refunded'],
                    type: 'string',
                  },
                  payment_type: {
                    enum: ['pay_in_4', 'pay_in_30', 'monthly_finance'],
                    type: 'string',
                  },
                  merchant_name: {
                    type: 'string',
                  },
                  merchant_order_number: {
                    type: 'string',
                    description:
                      'Show this beside the merchant and date so the customer RECOGNISES their order in the list. It is for recognition, never something to ask them to produce.',
                  },
                },
              },
              description: 'Show these to the customer and let them choose.',
            },
            showing: {
              enum: ['scoped', 'all'],
              type: 'string',
              description:
                '`scoped` means the filters narrowed the list; `all` means they matched nothing and the whole list is shown instead.',
            },
            scoped_by: {
              type: 'array',
              items: {
                type: 'string',
              },
              description:
                'Which filters were applied, so the customer can be told what was assumed.',
            },
            total_orders: {
              type: 'number',
              description: 'How many orders the customer has in total.',
            },
          },
        },
        selected_order_ref: {
          type: 'string',
          description:
            'Set only when the scoping left exactly one order — nothing to choose between.',
        },
      },
    }),
  },
  {
    name: 'Inspect an order',
    tags: [],
    method: 'GET',
    params: [
      {
        name: 'order_ref',
        schema: {
          type: 'string',
        },
        location: 'path',
        required: true,
      },
      {
        name: 'section_cursor',
        schema: {
          type: 'string',
          description: 'Continues a section that reported has_more.',
        },
        location: 'query',
        required: false,
      },
    ],
    endpointId: 'orderInspect',
    description:
      'Everything about one order. Sections appear only when they apply: a declined order carries a decline section and no plan, a refunded one carries refund activity. Long sections page with `has_more` and `section_cursor`.',
    pathTemplate: '/orders/{order_ref}',
    responseSchemas: envelope({
      type: 'object',
      required: ['order'],
      properties: {
        plan: {
          type: 'object',
          required: ['instalments', 'total_amount', 'amount_paid', 'amount_outstanding'],
          properties: {
            has_more: {
              type: 'boolean',
            },
            amount_paid: {
              type: 'number',
            },
            instalments: {
              type: 'array',
              items: {
                type: 'object',
                required: ['sequence', 'due_date', 'amount', 'instalment_status'],
                properties: {
                  amount: {
                    type: 'number',
                  },
                  due_date: {
                    type: 'string',
                  },
                  late_fee: {
                    type: 'number',
                  },
                  sequence: {
                    type: 'number',
                  },
                  paid_date: {
                    type: 'string',
                  },
                  payment_ref: {
                    type: 'string',
                    description: 'Set once a payment has been allocated to this instalment.',
                  },
                  instalment_status: {
                    enum: ['paid', 'scheduled', 'overdue', 'waived'],
                    type: 'string',
                  },
                },
              },
            },
            days_overdue: {
              type: 'number',
            },
            total_amount: {
              type: 'number',
            },
            next_due_date: {
              type: 'string',
            },
            section_cursor: {
              type: 'string',
            },
            accrued_late_fees: {
              type: 'number',
            },
            amount_outstanding: {
              type: 'number',
            },
          },
        },
        order: {
          type: 'object',
          required: [
            'order_ref',
            'merchant_name',
            'order_date',
            'amount',
            'currency',
            'order_status',
          ],
          properties: {
            amount: {
              type: 'number',
            },
            currency: {
              type: 'string',
            },
            order_ref: {
              type: 'string',
              description: 'Opaque. Pass to order.inspect; never shown to the customer as an id.',
            },
            order_date: {
              type: 'string',
            },
            order_status: {
              enum: ['declined', 'active', 'overdue', 'settled', 'cancelled', 'refunded'],
              type: 'string',
            },
            payment_type: {
              enum: ['pay_in_4', 'pay_in_30', 'monthly_finance'],
              type: 'string',
            },
            merchant_name: {
              type: 'string',
            },
            merchant_order_number: {
              type: 'string',
              description:
                'Show this beside the merchant and date so the customer RECOGNISES their order in the list. It is for recognition, never something to ask them to produce.',
            },
          },
        },
        claims: {
          type: 'object',
          required: ['can_open'],
          properties: {
            can_open: {
              type: 'boolean',
              description: 'Whether a NEW claim may be opened against this order.',
            },
            existing: {
              type: 'array',
              items: {
                type: 'object',
                required: ['claim_ref', 'claim_status', 'opened_date'],
                properties: {
                  reason: {
                    type: 'string',
                  },
                  claim_ref: {
                    type: 'string',
                  },
                  opened_date: {
                    type: 'string',
                  },
                  claim_status: {
                    type: 'string',
                  },
                },
              },
            },
            has_more: {
              type: 'boolean',
            },
            section_cursor: {
              type: 'string',
            },
            ineligible_reason: {
              enum: [
                'claim_already_open',
                'outside_claim_window',
                'order_not_delivered_yet',
                'order_cancelled',
                'merchant_dispute_required_first',
              ],
              type: 'string',
            },
            ineligible_explanation: {
              type: 'string',
              description: 'Say this when can_open is false.',
            },
          },
        },
        decline: {
          type: 'object',
          required: ['reason_code', 'customer_explanation'],
          properties: {
            reason_code: {
              enum: [
                'insufficient_purchasing_power',
                'card_declined_by_bank',
                'identity_check_failed',
                'merchant_not_eligible',
                'risk_review',
              ],
              type: 'string',
              description:
                'The reason the desk is PERMITTED to give. Risk detail beyond this is deliberately absent.',
            },
            suggested_next_step: {
              type: 'string',
            },
            customer_explanation: {
              type: 'string',
              description: 'Say this, in the customer’s language.',
            },
          },
        },
        refund_activity: {
          type: 'object',
          required: ['events', 'owner'],
          properties: {
            owner: {
              enum: ['merchant', 'provider', 'bank'],
              type: 'string',
              description:
                'Who the customer must chase. A refund the merchant has not sent is not ours to hurry.',
            },
            events: {
              type: 'array',
              items: {
                type: 'object',
                required: ['refund_ref', 'amount', 'received_from_merchant', 'disbursement'],
                properties: {
                  amount: {
                    type: 'number',
                  },
                  refund_ref: {
                    type: 'string',
                  },
                  destination: {
                    type: 'string',
                    description: 'Masked card or bank, when the money left us.',
                  },
                  expected_by: {
                    type: 'string',
                  },
                  disbursement: {
                    enum: [
                      'applied_to_plan',
                      'returned_to_card',
                      'returned_to_bank',
                      'pending',
                      'settled_externally',
                    ],
                    type: 'string',
                  },
                  fees_returned: {
                    type: 'number',
                  },
                  murabaha_profit_rebate: {
                    type: 'number',
                    description:
                      'Finance orders only: profit rebated when the principal is refunded early.',
                  },
                  received_from_merchant: {
                    type: 'string',
                    description: 'When the merchant’s money reached us.',
                  },
                },
              },
            },
            next_step: {
              type: 'string',
            },
            plan_allocation: {
              type: 'string',
              description: 'How a refund landed against the plan, when it did.',
            },
          },
        },
      },
    }),
  },
  {
    name: 'Search payments',
    tags: [],
    method: 'GET',
    params: [
      {
        name: 'payment_date',
        schema: {
          type: 'string',
        },
        location: 'query',
        required: false,
      },
      {
        name: 'amount',
        schema: {
          type: 'number',
        },
        location: 'query',
        required: false,
      },
      {
        name: 'masked_method',
        schema: {
          type: 'string',
          description: 'e.g. •••• 4417',
        },
        location: 'query',
        required: false,
      },
      {
        name: 'transaction_type',
        schema: {
          enum: ['instalment', 'settlement', 'refund', 'authorisation'],
          type: 'string',
        },
        location: 'query',
        required: false,
      },
      {
        name: 'merchant',
        schema: {
          type: 'string',
        },
        location: 'query',
        required: false,
      },
    ],
    endpointId: 'paymentsSearch',
    description:
      'Find a payment from what appears on the customer’s statement. Returns `ambiguous` with candidates when a date and amount match more than one, which duplicates routinely do.',
    pathTemplate: '/payments/search',
    responseSchemas: envelope({
      type: 'object',
      required: ['candidates'],
      properties: {
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            required: ['payment_ref', 'amount', 'payment_date', 'payment_status'],
            properties: {
              amount: {
                type: 'number',
              },
              order_ref: {
                type: 'string',
                description: 'Set when the payment is linked to an order.',
              },
              payment_ref: {
                type: 'string',
              },
              payment_date: {
                type: 'string',
              },
              masked_method: {
                type: 'string',
              },
              payment_status: {
                enum: ['captured', 'failed', 'reversed', 'pending', 'duplicate', 'unrecognised'],
                type: 'string',
              },
              instalment_sequence: {
                type: 'number',
              },
            },
          },
        },
        narrowing_hint: {
          type: 'string',
        },
      },
    }),
  },
  {
    name: 'Inspect a payment',
    tags: [],
    method: 'GET',
    params: [
      {
        name: 'payment_ref',
        schema: {
          type: 'string',
        },
        location: 'path',
        required: true,
      },
    ],
    endpointId: 'paymentInspect',
    description:
      'What actually happened to one payment, on both sides: what the processor did and what our ledger recorded. The two disagreeing IS the answer to most "you took my money twice" questions.',
    pathTemplate: '/payments/{payment_ref}',
    responseSchemas: envelope({
      type: 'object',
      required: ['payment_ref', 'processor_state', 'ledger_state'],
      properties: {
        amount: {
          type: 'number',
        },
        capture: {
          type: 'object',
          properties: {
            amount: {
              type: 'number',
            },
            captured_at: {
              type: 'string',
            },
          },
        },
        reversal: {
          type: 'object',
          properties: {
            amount: {
              type: 'number',
            },
            reason: {
              type: 'string',
            },
            expected_by: {
              type: 'string',
            },
            reversed_at: {
              type: 'string',
            },
          },
        },
        order_ref: {
          type: 'string',
        },
        allocation: {
          type: 'object',
          properties: {
            order_ref: {
              type: 'string',
            },
            allocated_amount: {
              type: 'number',
            },
            instalment_sequence: {
              type: 'number',
            },
          },
        },
        payment_ref: {
          type: 'string',
        },
        ledger_state: {
          enum: ['allocated', 'unallocated', 'refunded', 'written_off', 'not_recorded'],
          type: 'string',
        },
        payment_date: {
          type: 'string',
        },
        masked_method: {
          type: 'string',
        },
        refund_context: {
          type: 'object',
          properties: {
            owner: {
              type: 'string',
            },
            refund_ref: {
              type: 'string',
            },
            expected_by: {
              type: 'string',
            },
          },
        },
        processor_state: {
          enum: ['authorised', 'captured', 'declined', 'reversed', 'voided', 'unknown'],
          type: 'string',
        },
        duplicate_of_payment_ref: {
          type: 'string',
          description:
            'Set when this is the second capture of one intent. The first is the one that stands.',
        },
      },
    }),
  },
  {
    name: 'Inspect a claim',
    tags: [],
    method: 'GET',
    params: [
      {
        name: 'claim_ref',
        schema: {
          type: 'string',
        },
        location: 'path',
        required: true,
      },
    ],
    endpointId: 'claimInspect',
    description:
      'One claim end to end. `permitted_operations` is the claim’s own answer about what may be done to it next — a claim already resolved permits nothing, and offering the customer an action it refuses is worse than saying no.',
    pathTemplate: '/claims/{claim_ref}',
    responseSchemas: envelope({
      type: 'object',
      required: ['claim_ref', 'claim_status', 'owner', 'permitted_operations'],
      properties: {
        sla: {
          type: 'object',
          properties: {
            breached: {
              type: 'boolean',
            },
            responds_by: {
              type: 'string',
            },
            business_days_remaining: {
              type: 'number',
            },
          },
        },
        owner: {
          enum: ['provider', 'merchant', 'customer'],
          type: 'string',
        },
        reason: {
          type: 'string',
        },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            required: ['evidence_type', 'received_at'],
            properties: {
              accepted: {
                type: 'boolean',
              },
              received_at: {
                type: 'string',
              },
              evidence_type: {
                type: 'string',
              },
            },
          },
        },
        timeline: {
          type: 'array',
          items: {
            type: 'object',
            required: ['at', 'event'],
            properties: {
              at: {
                type: 'string',
              },
              actor: {
                type: 'string',
              },
              event: {
                type: 'string',
              },
            },
          },
        },
        claim_ref: {
          type: 'string',
        },
        order_ref: {
          type: 'string',
        },
        escalation: {
          type: 'object',
          properties: {
            tier: {
              type: 'string',
            },
            escalated: {
              type: 'boolean',
            },
            escalated_at: {
              type: 'string',
            },
          },
        },
        opened_date: {
          type: 'string',
        },
        claim_status: {
          enum: [
            'submitted',
            'awaiting_evidence',
            'with_merchant',
            'under_review',
            'resolved_upheld',
            'resolved_rejected',
            'cancelled',
          ],
          type: 'string',
        },
        permitted_operations: {
          type: 'array',
          items: {
            enum: ['cancel', 'submit_evidence', 'escalate'],
            type: 'string',
          },
        },
      },
    }),
  },
  {
    name: 'Open a claim',
    tags: [],
    method: 'POST',
    params: [
      {
        name: 'order_ref',
        schema: {
          type: 'string',
        },
        location: 'body',
        required: true,
      },
      {
        name: 'reason',
        schema: {
          enum: [
            'item_not_received',
            'item_not_as_described',
            'damaged',
            'unauthorised',
            'duplicate_charge',
          ],
          type: 'string',
        },
        location: 'body',
        required: true,
      },
      {
        name: 'detail',
        schema: {
          type: 'string',
        },
        location: 'body',
        required: true,
      },
      {
        name: 'customer_confirmed',
        schema: {
          type: 'boolean',
          description: 'The customer has been told what opening a claim does, and agreed.',
        },
        location: 'body',
        required: true,
      },
      {
        name: 'idempotency_key',
        schema: {
          type: 'string',
        },
        location: 'body',
        required: true,
      },
    ],
    endpointId: 'claimCreate',
    description:
      'Open a claim against an order the ORDER says is eligible. Check `claims.can_open` on the order first — this refuses otherwise, and the refusal carries the reason the customer should hear.',
    pathTemplate: '/claims',
    writeRiskTier: 'low',
    responseSchemas: envelope({
      type: 'object',
      required: ['claim_ref', 'claim_status', 'next_step'],
      properties: {
        claim_ref: {
          type: 'string',
        },
        next_step: {
          type: 'string',
          description: 'What happens now, and by when.',
        },
        claim_status: {
          type: 'string',
        },
        payments_paused: {
          type: 'boolean',
          description: 'Whether the plan stops collecting while the claim runs.',
        },
      },
    }),
  },
  {
    name: 'Cancel a claim',
    tags: [],
    method: 'POST',
    params: [
      {
        name: 'claim_ref',
        schema: {
          type: 'string',
        },
        location: 'path',
        required: true,
      },
      {
        name: 'customer_confirmed',
        schema: {
          type: 'boolean',
        },
        location: 'body',
        required: true,
      },
      {
        name: 'idempotency_key',
        schema: {
          type: 'string',
        },
        location: 'body',
        required: true,
      },
    ],
    endpointId: 'claimCancel',
    description:
      'Withdraw a claim the customer no longer wants. Refused when the claim does not permit it — a resolved claim cannot be un-resolved.',
    pathTemplate: '/claims/{claim_ref}/cancel',
    writeRiskTier: 'low',
    responseSchemas: envelope({
      type: 'object',
      required: ['claim_ref', 'claim_status', 'next_step'],
      properties: {
        claim_ref: {
          type: 'string',
        },
        next_step: {
          type: 'string',
        },
        claim_status: {
          type: 'string',
        },
      },
    }),
  },
  {
    name: 'Submit claim evidence',
    tags: [],
    method: 'POST',
    params: [
      {
        name: 'claim_ref',
        schema: {
          type: 'string',
        },
        location: 'path',
        required: true,
      },
      {
        name: 'evidence_type',
        schema: {
          enum: ['receipt', 'photo', 'merchant_correspondence', 'delivery_proof', 'police_report'],
          type: 'string',
        },
        location: 'body',
        required: true,
      },
      {
        name: 'description',
        schema: {
          type: 'string',
        },
        location: 'body',
        required: true,
      },
      {
        name: 'customer_confirmed',
        schema: {
          type: 'boolean',
          description: 'The customer has seen what is being sent on their behalf, and agreed.',
        },
        location: 'body',
        required: true,
      },
      {
        name: 'idempotency_key',
        schema: {
          type: 'string',
        },
        location: 'body',
        required: true,
      },
    ],
    endpointId: 'claimSubmitEvidence',
    description: 'Add evidence to a claim that is waiting for it.',
    pathTemplate: '/claims/{claim_ref}/evidence',
    writeRiskTier: 'low',
    responseSchemas: envelope({
      type: 'object',
      required: ['claim_ref', 'claim_status', 'accepted', 'next_step'],
      properties: {
        accepted: {
          type: 'boolean',
        },
        claim_ref: {
          type: 'string',
        },
        next_step: {
          type: 'string',
        },
        claim_status: {
          type: 'string',
        },
        rejection_reason: {
          type: 'string',
        },
      },
    }),
  },
  {
    name: 'Inspect credit reporting',
    tags: [],
    method: 'GET',
    params: [
      {
        name: 'order_ref',
        schema: {
          type: 'string',
          description: 'A finance order.',
        },
        location: 'query',
        required: false,
      },
    ],
    endpointId: 'creditReportingInspect',
    description:
      'What we report to SIMAH against what we hold, and when the two last agreed. A customer seeing an old balance on their bureau file is usually reading a real reporting lag, not an error — and the two states side by side is what lets the desk say which.',
    pathTemplate: '/credit-reporting',
    responseSchemas: envelope({
      type: 'object',
      required: ['provider_state', 'bureau_state', 'mismatch'],
      properties: {
        mismatch: {
          type: 'boolean',
          description: 'True when the two disagree beyond the reporting window.',
        },
        bureau_state: {
          type: 'object',
          required: ['outstanding_amount', 'account_status'],
          properties: {
            last_sync: {
              type: 'string',
            },
            account_status: {
              type: 'string',
            },
            outstanding_amount: {
              type: 'number',
            },
          },
        },
        provider_state: {
          type: 'object',
          required: ['outstanding_amount', 'account_status'],
          properties: {
            as_of: {
              type: 'string',
            },
            account_status: {
              enum: ['current', 'late', 'default', 'closed'],
              type: 'string',
            },
            outstanding_amount: {
              type: 'number',
            },
          },
        },
        next_sync_expected: {
          type: 'string',
        },
        mismatch_explanation: {
          type: 'string',
        },
        reporting_window_days: {
          type: 'number',
          description:
            'How long a change takes to reach the bureau. Inside this window a difference is expected.',
        },
      },
    }),
  },
  {
    name: 'Search past conversations',
    tags: [],
    method: 'GET',
    params: [
      {
        name: 'topic',
        schema: {
          type: 'string',
        },
        location: 'query',
        required: false,
      },
      {
        name: 'entity_ref',
        schema: {
          type: 'string',
        },
        location: 'query',
        required: false,
      },
      {
        name: 'limit',
        schema: {
          type: 'number',
        },
        location: 'query',
        required: false,
        defaultValue: '3',
      },
    ],
    endpointId: 'conversationHistorySearch',
    description:
      'What this customer was told before, and what was done. A summary records the state AT THAT TIME — re-check anything it asserts about the present against live state before repeating it.',
    pathTemplate: '/conversations/search',
    responseSchemas: envelope({
      type: 'object',
      required: ['conversations'],
      properties: {
        conversations: {
          type: 'array',
          items: {
            type: 'object',
            required: ['occurred_at', 'summary', 'outcome'],
            properties: {
              outcome: {
                type: 'string',
              },
              summary: {
                type: 'string',
              },
              entity_refs: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
              occurred_at: {
                type: 'string',
              },
              actions_taken: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
              state_may_have_changed: {
                type: 'boolean',
                description:
                  'True when the summary asserts something that live state can have moved since.',
              },
            },
          },
        },
      },
    }),
  },
  {
    name: 'Hand over to a human',
    tags: [],
    method: 'POST',
    params: [
      {
        name: 'issue_summary',
        schema: {
          type: 'string',
        },
        location: 'body',
        required: true,
      },
      {
        name: 'entity_refs',
        schema: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        location: 'body',
        required: true,
      },
      {
        name: 'verified_facts',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            description: 'Something confirmed from a tool result, not assumed.',
          },
        },
        location: 'body',
        required: true,
      },
      {
        name: 'attempts',
        schema: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        location: 'body',
        required: true,
      },
      {
        name: 'requested_outcome',
        schema: {
          type: 'string',
        },
        location: 'body',
        required: true,
      },
      {
        name: 'customer_confirmed',
        schema: {
          type: 'boolean',
        },
        location: 'body',
        required: true,
      },
    ],
    endpointId: 'handoverStart',
    description:
      'Move the conversation to a person, carrying what has already been established so the customer does not repeat themselves. Requires the facts already verified and the attempts already made — a handover that arrives empty costs the customer the whole conversation again.',
    pathTemplate: '/handover',
    writeRiskTier: 'low',
    responseSchemas: envelope({
      type: 'object',
      required: ['transfer_status', 'queue'],
      properties: {
        queue: {
          type: 'string',
        },
        fallback: {
          type: 'string',
          description: 'What happens if nobody picks up — a callback, a ticket, or hours.',
        },
        transfer_status: {
          enum: ['queued', 'connected', 'unavailable'],
          type: 'string',
        },
        conversation_locked: {
          type: 'boolean',
          description: 'The desk stops acting once a human owns the conversation.',
        },
        estimated_wait_minutes: {
          type: 'number',
        },
      },
    }),
  },
];

export const BNPL_CORE_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'bnpl-core',
  version: 1,
  name: 'Instalments Support Desk (simulated)',
  tagline: 'a lender support desk answered by a declared world, with no lender behind it',
  description:
    'Twelve endpoints covering orders, payment plans, refunds, claims, credit reporting and ' +
    'handover to a human. Installing it mints a simulation for the space and binds it, so calls ' +
    'are answered from a world rather than sent to a host — no credential, no egress, bound on ' +
    'arrival. The reference case for building an agent before the service it depends on exists.',
  tags: ['simulation', 'bnpl', 'support', 'example'],
  category: 'example',
  honestyLabel: 'curated',
  authKind: 'none',
  fulfillment: 'simulated',
  definition: {
    apiId: 'bnpl-core',
    name: 'Instalments Support Desk (simulated)',
    description:
      'A buy-now-pay-later support desk: orders, payment plans, refunds, claims and credit ' +
      'reporting, answered from a declared world.',
    baseUrl: 'https://simulated.invalid',
    version: '1',
    callMode: 'endpoint',
    tags: ['simulation', 'bnpl', 'support'],
    endpoints: ENDPOINTS,
  },
} as ConnectorCatalogEntry;
