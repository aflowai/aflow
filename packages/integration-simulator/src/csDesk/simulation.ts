import type { Simulation } from '@aflow/schemas';
import { CS_DESK_PERSONAS } from './baseline.js';
import { CS_DESK_COLLECTIONS } from './collections.js';
import { CS_DESK_API_ID } from './definition.js';
import { CS_DESK_HANDLERS } from './handlers/index.js';

const DOMAIN_BRIEF =
  'A consumer buy-now-pay-later lender operating in Saudi Arabia (SAR) and the UAE (AED). ' +
  'A customer buys from a merchant and repays the lender in instalments, so a refund is the ' +
  "merchant's money to return and the lender's plan to adjust — two legs that settle on " +
  'different clocks and can disagree. Orders carry a lifecycle and a payment plan; payments ' +
  'are attempts against a card that may authorise, capture, decline or reverse, and a bank ' +
  'debit is a separate fact from a capture. Disputes become claims owned by a merchant, the ' +
  'lender or the card scheme. Deadlines, decline-code meanings, market eligibility rules and ' +
  'queue routing are POLICY: they live in the world as rows, and an assessment that needs one ' +
  'the world does not hold is reported as unresolved rather than estimated. Every answer ' +
  'distinguishes three things that look alike and are not: a fact that is absent, a fact that ' +
  'is not yet visible because a source is lagging, and a fact that could not be read because a ' +
  'source failed.';

/**
 * The artifact as it is written to a space.
 *
 * `unmatched: 'error'` rather than the default: an endpoint with no handler
 * refuses by name instead of being answered by a model. While the decision
 * tables are being authored, an invented answer is worse than no answer —
 * it reads exactly like behaviour and is not.
 *
 * `disclosePersona` is true because the surface being simulated is an
 * in-app assistant, which receives its caller from the session. An assistant
 * that opens by asking for a customer id is rehearsing a conversation the
 * deployment never has.
 */
export function buildCsDeskSimulation(): Simulation {
  return {
    simulationId: 'cs-desk',
    revision: 1,
    name: 'Customer support desk',
    description:
      'The decision tables of the consumer-lending support desk, answered from an authored world.',
    targets: { sourceKind: 'api', integrationId: CS_DESK_API_ID },
    domainBrief: DOMAIN_BRIEF,
    personas: CS_DESK_PERSONAS.map((p) => ({ ...p })),
    defaultPersonaId: 'cus_sa_amal',
    disclosePersona: true,
    collections: CS_DESK_COLLECTIONS.map((c) => ({ ...c })) as Simulation['collections'],
    rules: [],
    handlers: CS_DESK_HANDLERS,
    effects: {},
    policy: { unmatched: 'error', maxGeneratedCallsPerRun: 0 },
  } as Simulation;
}
