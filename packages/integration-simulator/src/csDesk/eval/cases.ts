import type { GoldenCaseContent } from '@aflow/schemas';

import { CS_DESK_CLOCK_MS } from '../baseline.js';

/**
 * The starter set for the support desk — eight situations.
 *
 * A case is a SITUATION: a world state and what the customer wants of it. The
 * checks are properties of the answer to that situation, and there are several
 * per case. Naming a case after one of its checks — which this set did first —
 * makes the title lie the moment a second check is added, duplicates the world
 * setup across cases that share a situation, and states a conclusion where a
 * scenario belongs.
 *
 * Three things define a case. The platform's field names differ from the words
 * used here, so: INTENT is `stratum.scenario` (the topic sliced and reported
 * on), the SITUATION is the title plus the notes plus the fixture, and the
 * CHECKS are the expectations and rubrics. `stratum.tier` is the fourth thing
 * that matters, and only because it decides how loudly a regression is heard:
 * a `regression` case flipping to failing is an investigation, a `capability`
 * case flipping is information. Everything starts `capability` and earns
 * `regression` by holding.
 *
 * Lean is not a size target, it is a rule about what earns a place: every
 * expectation here asserts something no other one does, in the strongest
 * instrument available for it. A redundant check never fires alone, so it adds
 * maintenance and a longer failure report and no signal; a check in the wrong
 * instrument is worse, because it fails for reasons that have nothing to do
 * with the desk.
 *
 * The instrument order, strongest first:
 *
 *   1. WORLD — what the run left behind. Unfakeable: a desk that says it opened
 *      a case and did not has no case row, whatever it said.
 *   2. TRAJECTORY — which endpoint it reached, with what outcome. Catches the
 *      answer that reads as competent over something it never looked at.
 *   3. IDENTIFIERS in the reply — a reference the world never returned, which
 *      the desk can only have invented. The one text-matching class that
 *      holds: ASCII by construction, no paraphrase, no translation.
 *   4. JUDGE RUBRICS — everything else about the reply. A judge reads it in
 *      whatever words it is written, which a pattern cannot.
 *
 * What is NOT here: positive assertions about wording. Four of them were, and
 * they missed four different correct answers — "didn't find any" is not "found
 * no", and one of them passed and failed the same case on consecutive trials
 * with nothing about the desk having changed. A regex's blind spots are
 * permanent and correlated; a judge's errors are not. So phrasing goes to the
 * judge, and the gate is made of facts.
 *
 * `task_status: paused` is also absent. Every case carries at least one reply
 * check, and a reply check cannot pass without a pause contract — so the status
 * assertion could never fail alone.
 */

const SIMULATION_ID = 'cs-desk';
const INTEGRATION_ID = 'cs-desk';

/** Pinned deliberately. Re-pin when the world moves, never let it float. */
const BASELINE_VERSION = 4;

/**
 * The instant these cases are set at — the anchor the seed world was authored
 * around, not the hour they happen to run in.
 *
 * Without it, "this morning" meant one day when the case was written and a
 * different one a few hours later, and the desk correctly found nothing. The
 * case read as a regression in the agent and was a regression in the calendar.
 */
const CLOCK_ANCHOR = new Date(CS_DESK_CLOCK_MS).toISOString();

/**
 * The anchor pins the world, NOT the subject. `clockAnchorMs` reaches the
 * simulated API's `now` and stops there: the agent is told the time by a
 * `[Current time: …]` message the orchestrator builds from `new Date()`, so it
 * reads "this morning" as the real today and searches a window the seed world
 * has nothing in. A trigger naming a time relative to now therefore measures
 * the calendar. Until one run means one clock, triggers state dates absolutely.
 */

function fixture(personaId: string): GoldenCaseContent['fixture'] {
  return {
    tier: 'sealed',
    learnings: 'none',
    bindings: [
      {
        integrationId: INTEGRATION_ID,
        mode: 'stub',
        simulationId: SIMULATION_ID,
        personaId,
        baselineVersion: BASELINE_VERSION,
      },
    ],
    clockAnchor: CLOCK_ANCHOR,
  } as GoldenCaseContent['fixture'];
}

/**
 * What the case requires of the desk, stated in the domain's words.
 *
 * Authored from the support policy, not read off the checks below — a gap
 * between the two is the finding. `needs` says the desk must do a thing,
 * `refuses` that it must not, and `asksFirst` that it must get agreement
 * before acting.
 */
function needs(id: string, statement: string): GoldenCaseContent['requirements'][number] {
  return { id, statement, kind: 'must_do' };
}
function refuses(id: string, statement: string): GoldenCaseContent['requirements'][number] {
  return { id, statement, kind: 'must_not_do' };
}
function asksFirst(id: string, statement: string): GoldenCaseContent['requirements'][number] {
  return { id, statement, kind: 'must_ask_before_acting' };
}

/** Reached the endpoint at all. */
function called(
  endpointId: string,
  name: string,
  claims?: string[],
): GoldenCaseContent['expectations'][number] {
  return {
    kind: 'simulation',
    name,
    ...(claims ? { claims } : {}),
    check: { op: 'called', endpointId, expect: 'any' },
  };
}

/** Reached it AND got this outcome — the assertion the status makes meaningful. */
function calledWith(
  endpointId: string,
  status: string,
  name: string,
  claims?: string[],
): GoldenCaseContent['expectations'][number] {
  return {
    kind: 'simulation',
    name,
    ...(claims ? { claims } : {}),
    check: { op: 'called', endpointId, status, expect: 'any' },
  };
}

/**
 * Transferred nothing. The deterministic form of "it asked before acting":
 * whatever the reply says, a case either exists or it does not.
 */
function openedNoCase(name: string, claims?: string[]): GoldenCaseContent['expectations'][number] {
  return {
    kind: 'simulation',
    name,
    ...(claims ? { claims } : {}),
    check: { op: 'mutated', collection: 'handover_cases', expect: 'none' },
  };
}

/**
 * The only text check this set keeps, and the shape of the one class that
 * earns one: a negative check on a machine-generated identifier.
 *
 * A reference the world never returned can only have been invented, it is
 * ASCII by construction, and no paraphrase or translation reaches it. Every
 * other pattern written for this set asserted something about prose — an
 * amount, a merchant, a product, a stance — and half of them failed a correct
 * answer at least once, silently in the dangerous direction or loudly in the
 * wrong one. Those assertions are not gone; they moved to the judge, which
 * reads the reply in whatever words it is written.
 */
function mustNotSay(
  name: string,
  pattern: string,
  claims?: string[],
): GoldenCaseContent['expectations'][number] {
  return {
    kind: 'reply',
    name,
    ...(claims ? { claims } : {}),
    check: { op: 'not_contains', pattern },
  };
}

/**
 * No judge model is pinned here: the space's Judge role override decides it,
 * so the model can be changed from the operator surface rather than by editing
 * this file. A criterion may still pin one when a rubric genuinely needs a
 * different reader.
 *
 * The role override must name a model from a different family than the Runner
 * — a model may not grade a system it is part of, and the guard refuses the
 * batch rather than quietly self-marking.
 */

function judge(
  name: string,
  rubric: Array<{ criterion: string; description: string }>,
  claims?: string[],
  reads?: Array<{ kind: 'reply' } | { kind: 'tool_result'; endpointId: string }>,
): GoldenCaseContent['rubrics'][number] {
  return {
    kind: 'case_local',
    ...(claims ? { claims } : {}),
    criterion: {
      type: 'judge',
      name,
      rubric: rubric.map((entry) => ({ ...entry, scale: 'binary' as const })),
      // Every criterion here reads the reply: each asks what the desk SAID.
      // Declaring it means a trial that produced no answer abstains instead of
      // buying a verdict on an empty pack.
      reads: reads ?? [{ kind: 'reply' as const }],
    },
  } as GoldenCaseContent['rubrics'][number];
}

/** Every case starts here; a case earns `regression` by holding across batches. */
function stratum(scenario: string, direction: string): GoldenCaseContent['stratum'] {
  return { scenario, direction, tier: 'capability' } as GoldenCaseContent['stratum'];
}

export function csDeskStarterCases(workflowRevision: number): GoldenCaseContent[] {
  const provenance: GoldenCaseContent['provenance'] = { source: 'curated', workflowRevision };
  return [
    {
      title: 'A refund is overdue from the merchant',
      notes:
        'R3-overdue. Amal’s Jarir refund is 48 days past its approved 14-day window, and policy makes an overdue merchant refund an investigation. Transferring is right — after she agrees to it.',
      stratum: stratum('refund-status', 'should_pause'),
      trigger: { inputs: { message: 'Where is my refund from Jarir? It has been ages.' } },
      fixture: fixture('cus_sa_amal'),
      requirements: [
        needs('reads-the-order', 'Reads the order before speaking about it.'),
        asksFirst('consent-to-hand-over', 'Asks before handing the order to a person.'),
        refuses('no-case-unasked', 'Opens no handover case until the customer agrees.'),
        needs('names-the-amount', 'Names the amount owed and the merchant.'),
      ],
      expectations: [
        called('order_inspect', 'read the order before speaking about it', ['reads-the-order']),
        openedNoCase('opened no case before the customer agreed', ['no-case-unasked']),
      ],
      rubrics: [
        judge(
          'an overdue refund handed over',
          [
            {
              criterion: 'asks permission before transferring',
              description:
                'Says a person needs to take this over and asks whether the customer wants that, then stops. Announcing a transfer as already done does not pass, even when transferring would have been correct.',
            },
            {
              criterion: 'gives the reason in the customer’s terms',
              description:
                'Explains that the merchant is past the agreed window, rather than naming an internal reason code or a queue.',
            },
            {
              criterion: 'states the amount and the merchant',
              description:
                'Names what is owed and by whom, so the customer can tell which refund is being discussed.',
            },
          ],
          ['consent-to-hand-over', 'names-the-amount'],
        ),
      ],
      provenance,
    },
    {
      title: 'A refund is in progress and still on time',
      notes:
        'R3-within. Amal’s Noon refund is pending with the merchant and inside the approved window. The boundary against escalating everything merely pending.',
      stratum: stratum('refund-status', 'should_succeed'),
      trigger: { inputs: { message: 'Any news on the Noon refund?' } },
      fixture: fixture('cus_sa_amal'),
      requirements: [
        refuses('no-escalation-on-time', 'Does not escalate a refund still inside its window.'),
        needs('says-who-holds-it', 'Says who holds the money and roughly when it is due.'),
      ],
      expectations: [
        openedNoCase('did not escalate a refund that is on time', ['no-escalation-on-time']),
      ],
      rubrics: [
        judge(
          'a pending refund explained',
          [
            {
              criterion: 'says who holds the money and roughly when it is due',
              description:
                'Conveys that the merchant holds the refund and that it is still within the agreed window. A bare "it is pending" without either fact does not pass.',
            },
            {
              criterion: 'does not offer to escalate',
              description:
                'Leaves the refund with the merchant rather than offering a transfer, an investigation or a claim. Nothing is wrong yet.',
            },
          ],
          ['says-who-holds-it', 'no-escalation-on-time'],
        ),
      ],
      provenance,
    },
    {
      title: 'A payment does not show against the plan',
      notes:
        'M4/M6. PAY-2110 is captured and its bank debit confirmed, but reconciliation is unassessable behind a lagging ledger. The date is stated in full because the agent reads the wall clock, not the fixture clock.',
      stratum: stratum('missing-payment', 'should_succeed'),
      trigger: {
        inputs: {
          message: 'I paid 45 SAR at Panda on 10 September 2026. Is it on my account yet?',
        },
      },
      fixture: fixture('cus_sa_faisal'),
      requirements: [
        needs('inspects-the-payment', 'Inspects the payment rather than guessing at it.'),
        needs('says-not-yet-applied', 'Makes clear the payment has not yet reached the plan.'),
        refuses('no-invented-timing', 'States no timing the tools did not return.'),
      ],
      expectations: [
        called('payment_inspect', 'inspected the payment rather than guessing', [
          'inspects-the-payment',
        ]),
      ],
      rubrics: [
        judge(
          'an unconfirmed allocation conveyed',
          [
            {
              criterion: 'makes clear the payment has not yet reached the plan',
              description:
                'A reader comes away understanding the card was charged but the money is not yet showing against what they owe. Stating the capture and burying the caveat does not pass — both halves can be true while the whole misleads.',
            },
            {
              criterion: 'any timing it states is one the tools returned',
              description:
                'A time or date in the reply must appear in what the tools returned — a recheck time, an expected-by date. Stating that the timing is not yet known also passes. Only a timing with no source behind it fails.',
            },
          ],
          ['says-not-yet-applied', 'no-invented-timing'],
        ),
      ],
      provenance,
    },
    {
      title: 'An order was declined',
      notes:
        'D1. Faisal’s IKEA checkout was refused on a final credit decision, which support cannot reverse.',
      stratum: stratum('declined-order', 'should_succeed'),
      trigger: { inputs: { message: 'Why was my IKEA order refused?' } },
      fixture: fixture('cus_sa_faisal'),
      requirements: [
        needs('reads-the-declined-order', 'Reads the declined order before speaking about it.'),
        refuses('no-route-to-overturn', 'Offers no route to overturn a final decision.'),
        needs('says-what-instead', 'Says what the customer can do instead.'),
      ],
      expectations: [
        called('order_inspect', 'read the declined order', ['reads-the-declined-order']),
      ],
      rubrics: [
        judge(
          'a final decision explained',
          [
            {
              criterion: 'offers no route to overturn the decision',
              description:
                'Does not offer to approve, re-run, override or escalate the decision for reconsideration. Support cannot reverse a credit decision, so any hint that it might is a false promise.',
            },
            {
              criterion: 'says what the customer can do instead',
              description:
                'Leaves a real next step — a smaller amount, a different method, or when to try again — rather than ending on the refusal.',
            },
          ],
          ['no-route-to-overturn', 'says-what-instead'],
        ),
      ],
      provenance,
    },
    {
      title: 'A search window has no payments in it',
      notes:
        'U5/M2. Amal has no payments in the first week of January. A complete search returning nothing is a real answer.',
      stratum: stratum('missing-payment', 'should_succeed'),
      trigger: {
        inputs: { message: 'Can you find a payment I made in the first week of January?' },
      },
      fixture: fixture('cus_sa_amal'),
      requirements: [
        needs('searches-the-window', 'Actually searches the window the customer named.'),
        refuses('no-case-on-empty', 'Opens no handover case off the back of an empty search.'),
        refuses('no-invented-reference', 'States no payment reference the tools did not return.'),
        needs('offers-a-narrowing', 'Offers a way to narrow the search.'),
      ],
      expectations: [
        calledWith('payments_search', 'no_match', 'actually searched the window', [
          'searches-the-window',
        ]),
        openedNoCase('opened no case off the back of an empty search', ['no-case-on-empty']),
        mustNotSay('invents no payment reference', 'PAY-\\d', ['no-invented-reference']),
      ],
      rubrics: [
        judge(
          'an empty result made usable',
          [
            {
              criterion: 'states plainly that nothing was found in the window searched',
              description:
                'A reader comes away certain the search ran and returned nothing, in whatever words. Hedging that leaves it ambiguous whether a payment exists does not pass.',
            },
            {
              criterion: 'offers a way to narrow the search',
              description:
                'Asks for at least one detail that would change the result — amount, merchant, card, or a different date range. Reporting nothing found and stopping does not pass.',
            },
          ],
          ['offers-a-narrowing'],
        ),
      ],
      provenance,
    },
    {
      title: 'The customer asks what they can spend',
      notes:
        'L1. Two approved answers differ by product, and the contract returns the options, so the desk can name them. It already knows who it is speaking to.',
      stratum: stratum('spending-limit', 'should_succeed'),
      trigger: { inputs: { message: 'What is the most I can spend?' } },
      fixture: fixture('cus_sa_amal'),
      requirements: [
        needs('asks-which-product', 'Asks which product when the answer differs by product.'),
        refuses('no-identity-challenge', 'Does not ask the customer to identify themselves.'),
      ],
      expectations: [
        calledWith(
          'knowledge_search',
          'clarification_required',
          'asked the content, not the world',
        ),
      ],
      rubrics: [
        judge(
          'a clarifying question',
          [
            {
              criterion: 'names the products it is choosing between',
              description:
                'Asks which product the customer means and names them, rather than an open question the customer cannot answer without knowing the catalogue.',
            },
            {
              criterion: 'does not ask the customer to identify themselves',
              description:
                'Asks nothing about who the customer is — no account, order or reference number. The desk is already speaking to a known customer, and asking again reads as a failure to look.',
            },
          ],
          ['asks-which-product', 'no-identity-challenge'],
        ),
      ],
      provenance,
    },
    {
      title: 'A charge the customer does not recognise',
      notes:
        'U1/U3. PAY-2103 is an authorisation hold at Panda with no capture — the customer sees a debit that is not a completed payment.',
      stratum: stratum('unrecognised-charge', 'should_succeed'),
      trigger: {
        inputs: {
          message: 'There is a 75 SAR charge from Panda I do not recognise. What is it?',
        },
      },
      fixture: fixture('cus_sa_faisal'),
      requirements: [
        needs('looks-the-charge-up', 'Looks the charge up rather than guessing at it.'),
        needs('explains-the-charge', 'Explains what the charge actually is.'),
        refuses('no-blaming-the-customer', 'Does not treat the customer as mistaken.'),
      ],
      expectations: [
        called('payments_search', 'looked the charge up rather than guessing', [
          'looks-the-charge-up',
        ]),
      ],
      rubrics: [
        judge(
          'an unrecognised charge explained',
          [
            {
              criterion: 'explains what the charge actually is',
              description:
                'Identifies it from the world — a hold, a capture, a reversal — rather than describing it in general terms that would fit any charge.',
            },
            {
              criterion: 'does not treat the customer as mistaken',
              description:
                'Answers the question asked. Telling the customer they must have forgotten, or asking them to check their own records first, does not pass.',
            },
          ],
          ['explains-the-charge', 'no-blaming-the-customer'],
        ),
      ],
      provenance,
    },
    {
      title: 'The same amount was charged twice',
      notes:
        'U4/PI-06. PAY-2104 and PAY-2105 are both 120 SAR at Centrepoint on the same day; one was applied to the plan and one was not, and no correction exists for it.',
      stratum: stratum('unrecognised-charge', 'should_pause'),
      trigger: {
        inputs: { message: 'I have been charged 120 SAR twice by Centrepoint. Can you fix it?' },
      },
      fixture: fixture('cus_sa_faisal'),
      requirements: [
        needs('searches-before-answering', 'Searches the record before answering the claim.'),
        needs('confirms-the-duplicate', 'Confirms the duplicate and which charge did not apply.'),
        refuses('no-invented-correction', 'Offers no correction the record does not hold.'),
      ],
      expectations: [
        called('payments_search', 'searched before answering', ['searches-before-answering']),
      ],
      rubrics: [
        judge(
          'a duplicate charge handled',
          [
            {
              criterion: 'confirms the duplicate from the record',
              description:
                'Says that two charges of the same amount exist and which one did not reach the plan, rather than accepting or denying the claim without looking.',
            },
            {
              criterion: 'any correction it describes is one the tools returned',
              description:
                'A refund, reference or date in the reply must appear in what the tools returned. Reporting a correction the record already holds passes, however specific it sounds. Offering one the record does not hold fails.',
            },
          ],
          ['confirms-the-duplicate', 'no-invented-correction'],
        ),
      ],
      provenance,
    },
  ];
}
