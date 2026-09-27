import { describe, expect, it } from 'vitest';
import { ApiEndpointSchema, SimulationSchema, type ApiEndpoint } from '@aflow/schemas';
import { compileSchema } from '../schemaCheck.js';
import { simulationReadiness } from '../readiness.js';
import { CS_DESK_BASELINE, CS_DESK_CLOCK_MS, CS_DESK_PERSONAS } from './baseline.js';
import { CS_DESK_COLLECTIONS } from './collections.js';
import { CS_DESK_DEFINITION, CS_DESK_ENDPOINTS } from './definition.js';
import { CS_DESK_HANDLERS } from './handlers/index.js';
import { buildCsDeskSimulation } from './simulation.js';
import { callDesk, reasons, worldFor, type DeskAnswer } from './harness.js';

/**
 * The desk's decision tables, one test per rule id.
 *
 * Named by rule id on purpose: a specification row that no test names is a row
 * nobody implemented, and that is visible here rather than discovered in a
 * conversation.
 */

const endpoints: ApiEndpoint[] = CS_DESK_ENDPOINTS.map((e) => ApiEndpointSchema.parse(e));
const NOW = CS_DESK_CLOCK_MS;

const AMAL = 'cus_sa_amal';
const RANA = 'cus_ae_rana';
const FAISAL = 'cus_sa_faisal';

function ask(endpointId: string, body: unknown, personaId: string | null, over = {}) {
  return callDesk(endpoints, { endpointId, body, personaId, nowMs: NOW, ...over });
}

// ============================================================================
// The world itself
// ============================================================================

describe('the seed world', () => {
  it('validates every row against the collection that holds it', () => {
    for (const collection of CS_DESK_COLLECTIONS) {
      const compiled = compileSchema(collection.schema as Record<string, unknown>);
      expect(
        compiled.ok,
        `${collection.collection} schema: ${compiled.ok ? '' : compiled.detail}`,
      ).toBe(true);
      if (!compiled.ok) continue;
      const rows = CS_DESK_BASELINE[collection.collection] ?? [];
      for (const row of rows) {
        expect(
          compiled.validate(row),
          `${collection.collection} row ${String(row[collection.identityField])}: ${JSON.stringify(compiled.validate.errors)}`,
        ).toBe(true);
        expect(
          row[collection.identityField],
          `${collection.collection} row is missing its identity`,
        ).toBeTypeOf('string');
      }
    }
  });

  it('parses as a simulation artifact', () => {
    const parsed = SimulationSchema.parse(buildCsDeskSimulation());
    expect(parsed.simulationId).toBe('cs-desk');
    expect(parsed.policy.unmatched).toBe('error');
    expect(parsed.personas.map((p) => p.personaId)).toEqual(
      CS_DESK_PERSONAS.map((p) => p.personaId),
    );
  });

  it('reports an endpoint world-ready once it has a handler', () => {
    const report = simulationReadiness(
      CS_DESK_DEFINITION as never,
      SimulationSchema.parse(buildCsDeskSimulation()),
    );
    const byId = new Map(report.endpoints.map((e) => [e.endpointId, e.readiness]));
    for (const endpoint of CS_DESK_ENDPOINTS) {
      expect(byId.get(endpoint.endpointId), endpoint.endpointId).toBe(
        CS_DESK_HANDLERS[endpoint.endpointId] ? 'world_ready' : 'contract_ready',
      );
    }
  });

  // The completeness gate. A collection nothing reads is seed data that can
  // never reach an answer, so this is empty exactly when every handler exists
  // and names what it uses — which is what "done" means for this build.
  it('leaves no collection unread once every endpoint has a handler', () => {
    const report = simulationReadiness(
      CS_DESK_DEFINITION as never,
      SimulationSchema.parse(buildCsDeskSimulation()),
    );
    const named = new Set(Object.values(CS_DESK_HANDLERS).flatMap((h) => h.collections));
    const unread = report.diagnostics.map((d) => d.collection);
    expect(report.diagnostics.every((d) => d.code === 'collection_unread')).toBe(true);
    expect(unread.filter((c) => c !== undefined && named.has(c))).toEqual([]);
    expect(CS_DESK_ENDPOINTS.every((e) => CS_DESK_HANDLERS[e.endpointId]) ? unread : []).toEqual(
      [],
    );
  });

  it('narrows every owned collection to the caller, and reads nobody as empty', () => {
    const amal = worldFor(AMAL);
    expect(amal['orders']?.every((o) => o['customer_id'] === AMAL)).toBe(true);
    expect(amal['orders']?.length).toBeGreaterThan(0);
    // Shared reference data belongs to no one and stays whole.
    expect(amal['policies']?.length).toBe(CS_DESK_BASELINE['policies']?.length);

    const nobody = worldFor(null);
    expect(nobody['orders']).toEqual([]);
    expect(nobody['payments']).toEqual([]);
    expect(nobody['policies']?.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// knowledge.search — KS-01 … KS-05
// ============================================================================

describe('knowledge.search', () => {
  const refundQuestion = {
    topic: 'refunds',
    question: 'How long does a refund take?',
    language: 'en',
  };

  it('KS-01: a content source that failed is unavailable, never no-content', async () => {
    const answer = await ask('knowledge_search', refundQuestion, AMAL, {
      overrides: {
        source_health: [
          {
            source_key: 'knowledge',
            state: 'failed',
            as_of: null,
            recheck_at: null,
            retryable: true,
            applies_to: ['knowledge_search'],
          },
        ],
      },
    });
    expect(answer.status).toBe('unavailable');
    expect(answer.errorRecovery?.code).toBe('source_unavailable');
    expect(answer.errorRecovery?.retryable).toBe(true);
    expect(answer.result['uncovered_question']).toBeUndefined();
  });

  it('KS-02: asks for the missing discriminator and nothing else', async () => {
    const answer = await ask(
      'knowledge_search',
      { topic: 'purchase_limits', question: 'What is the maximum I can spend?', language: 'en' },
      AMAL,
    );
    expect(answer.status).toBe('clarification_required');
    expect(answer.errorRecovery?.missing_fields).toEqual(['product']);
  });

  it('KS-02: naming the product selects one answer', async () => {
    const answer = await ask(
      'knowledge_search',
      {
        topic: 'purchase_limits',
        question: 'What is the maximum I can spend?',
        language: 'en',
        product: 'pay_in_4',
      },
      AMAL,
    );
    expect(answer.status).toBe('answer_found');
    expect(
      (answer.result['guidance'] as { source: { article_id: string } }).source.article_id,
    ).toBe('KB-008');
  });

  it('KS-03: answers with the approved article, its version and effective date', async () => {
    const answer = await ask('knowledge_search', refundQuestion, AMAL);
    expect(answer.status).toBe('answer_found');
    const guidance = answer.result['guidance'] as {
      source: { article_id: string; version: string };
      conditions: string[];
    };
    expect(guidance.source.article_id).toBe('KB-001');
    expect(guidance.source.version).toBe('3');
    expect(guidance.conditions.length).toBeGreaterThan(0);
  });

  it('KS-03: excludes withdrawn content and other markets', async () => {
    const answer = await ask('knowledge_search', refundQuestion, AMAL);
    const chosen = (answer.result['guidance'] as { source: { article_id: string } }).source
      .article_id;
    // KB-010 is the withdrawn version of the same answer; KB-007 is the UAE one.
    expect(chosen).not.toBe('KB-010');
    expect(chosen).not.toBe('KB-007');

    const uae = await ask('knowledge_search', refundQuestion, RANA);
    expect((uae.result['guidance'] as { source: { article_id: string } }).source.article_id).toBe(
      'KB-007',
    );
  });

  it('KS-03: selects the localized article for the requested language', async () => {
    const answer = await ask('knowledge_search', { ...refundQuestion, language: 'ar' }, AMAL);
    expect(answer.status).toBe('answer_found');
    expect(
      (answer.result['guidance'] as { source: { article_id: string } }).source.article_id,
    ).toBe('KB-002');
  });

  it('KS-04: returns the guidance and the approved fallback, never a constructed route', async () => {
    const answer = await ask(
      'knowledge_search',
      {
        topic: 'purchase_limits',
        question: 'Why did my limit drop?',
        language: 'en',
        product: 'general',
      },
      AMAL,
    );
    expect(answer.status).toBe('partial');
    const missing = answer.result['missing_link'] as {
      requested: string;
      approved_fallback: string;
    };
    expect(missing.requested).toBe('Check your limit in the app');
    expect(missing.approved_fallback).toContain('no approved deep link');
    const guidance = answer.result['guidance'] as { links?: unknown[] };
    expect(guidance.links).toBeUndefined();
  });

  it('KS-05: a completed lookup with no approved content, and the fallback decides escalation', async () => {
    const answer = await ask(
      'knowledge_search',
      { topic: 'payment_reversals', question: 'Why was I charged twice?', language: 'en' },
      RANA,
    );
    expect(answer.status).toBe('no_approved_content');
    expect(answer.result['uncovered_question']).toBe('Why was I charged twice?');
    expect(reasons(answer)).toEqual(['customer_requested_human']);
  });

  it('KS-05: no approved fallback means no escalation is invented', async () => {
    const answer = await ask(
      'knowledge_search',
      { topic: 'payment_reversals', question: 'Why was I charged twice?', language: 'en' },
      RANA,
      {
        overrides: {
          policies: (CS_DESK_BASELINE['policies'] ?? []).filter(
            (p) => p['policy_key'] !== 'knowledge_fallback',
          ),
        },
      },
    );
    expect(answer.status).toBe('no_approved_content');
    expect(answer.result['fallback']).toBeUndefined();
    expect(answer.escalations).toEqual([]);
  });

  it('KS-02: a lone product-specific article is not served to a question that named no product', async () => {
    // The discriminator guard required two or more effective articles, so a
    // topic covered by exactly one product-specific article answered a
    // general question with that product's policy — the same confusion KS-02
    // exists to prevent, one article short of triggering it.
    const answer = await ask('knowledge_search', refundQuestion, AMAL, {
      overrides: {
        knowledge_articles: [
          {
            article_id: 'KB-ONLY',
            topic: 'refunds',
            market: 'SA',
            language: 'en',
            product: 'pay-in-4',
            title: 'Refunds on Pay in 4',
            body: 'Pay in 4 refunds settle against the remaining instalments first.',
            conditions: [],
            version: '1',
            effective_from: '2026-01-01T00:00:00.000Z',
            effective_to: null,
            links: [],
          },
        ],
      },
    });
    expect(answer.status).toBe('clarification_required');
    expect(answer.errorRecovery?.missing_fields).toEqual(['product']);
  });
});

describe('claim.inspect', () => {
  it('CI-01: a completed lookup that resolves nothing is not_found', async () => {
    const answer = await ask('claim_inspect', { claim_ref: 'CLM-0000' }, RANA);
    expect(answer.status).toBe('not_found');
    expect(answer.errorRecovery?.code).toBe('not_found');
    expect(answer.errorRecovery?.message).toContain('other support cases');
  });

  it('CI-02: a failed claim service is unavailable, and differs from a closed claim', async () => {
    const answer = await ask('claim_inspect', { claim_ref: 'CLM-4201' }, RANA, {
      overrides: {
        source_health: [
          {
            source_key: 'claims',
            state: 'failed',
            as_of: null,
            recheck_at: null,
            retryable: true,
            applies_to: ['claim_inspect'],
          },
        ],
      },
    });
    expect(answer.status).toBe('unavailable');
    expect(answer.errorRecovery?.code).toBe('source_unavailable');
    expect(answer.result['state']).toBeUndefined();
  });

  it('CI-03: an open claim under human review creates no duplicate case', async () => {
    const answer = await ask('claim_inspect', { claim_ref: 'CLM-4201' }, RANA);
    expect(answer.status).toBe('found');
    expect(answer.result['state']).toBe('under_review');
    expect(answer.result['human_action_in_progress']).toBe(true);
    expect(answer.result['required_party']).toBe('merchant');
    expect(answer.escalations).toEqual([]);
  });

  it('CI-04: a claim waiting on the customer names the party and the exact evidence', async () => {
    const answer = await ask('claim_inspect', { claim_ref: 'CLM-4202' }, RANA);
    expect(answer.status).toBe('found');
    expect(answer.result['required_party']).toBe('customer');
    expect(answer.result['evidence_requirements']).toEqual(['courier_receipt', 'return_reference']);
    expect(answer.escalations).toEqual([]);
  });

  it('CI-05: a resolved claim carries its outcome and infers no disagreement', async () => {
    const answer = await ask('claim_inspect', { claim_ref: 'CLM-4203' }, RANA);
    expect(answer.status).toBe('found');
    expect(answer.result['state']).toBe('resolved');
    expect(answer.result['outcome']).toContain('Refund settled');
    expect(answer.result['required_party']).toBeNull();
    expect(answer.escalations).toEqual([]);
  });

  it('CI-06: past its approved deadline it escalates, with the reason from policy', async () => {
    const answer = await ask('claim_inspect', { claim_ref: 'CLM-4204' }, RANA);
    expect(answer.status).toBe('found');
    expect(reasons(answer)).toEqual(['refund_failure']);
    expect(answer.escalations[0]?.scope).toBe('claim');
  });

  it('CI-06: an unpublished deadline is policy_unresolved, never an assumed one', async () => {
    const answer = await ask('claim_inspect', { claim_ref: 'CLM-4204' }, RANA, {
      overrides: {
        policies: (CS_DESK_BASELINE['policies'] ?? []).filter(
          (p) => p['policy_key'] !== 'claim_update_deadline',
        ),
      },
    });
    expect(answer.status).toBe('partial');
    expect(answer.errorRecovery?.code).toBe('policy_unresolved');
    expect(answer.escalations).toEqual([]);
  });

  it('reads nothing for a caller acting as nobody', async () => {
    const answer = await ask('claim_inspect', { claim_ref: 'CLM-4201' }, null);
    expect(answer.status).toBe('not_found');
  });
});

// ============================================================================
// orders.select — OS-01 … OS-04
// ============================================================================

function withoutPolicy(key: string) {
  return { policies: (CS_DESK_BASELINE['policies'] ?? []).filter((p) => p['policy_key'] !== key) };
}

function sourceFailed(key: string, appliesTo: string[]) {
  return {
    source_health: [
      {
        source_key: key,
        state: 'failed',
        as_of: null,
        recheck_at: null,
        retryable: true,
        applies_to: appliesTo,
      },
    ],
  };
}

describe('orders.select', () => {
  it('OS-01: a resolver that failed is distinct from having no orders', async () => {
    const answer = await ask('orders_select', {}, AMAL, {
      overrides: sourceFailed('orders', ['orders_select']),
    });
    expect(answer.status).toBe('unavailable');
    expect(answer.errorRecovery?.code).toBe('source_unavailable');
  });

  it('OS-02: a supplied reference resolves straight to a selection', async () => {
    const answer = await ask('orders_select', { order_reference: 'ORD-1001' }, AMAL);
    expect(answer.status).toBe('selected');
    expect(answer.result['selected_order_ref']).toBe('ORD-1001');
  });

  it("OS-02: another customer's reference resolves to nothing, not to their order", async () => {
    const answer = await ask('orders_select', { order_reference: 'ORD-1201' }, AMAL);
    expect(answer.status).toBe('no_match');
    expect(answer.result['selected_order_ref']).toBeNull();
    expect(answer.result['candidates']).toEqual([]);
  });

  it('OS-03: an empty request opens the default scope and selects nothing', async () => {
    const answer = await ask('orders_select', {}, AMAL);
    expect(answer.status).toBe('candidates');
    expect(answer.result['selected_order_ref']).toBeNull();
    const page = answer.result['page'] as {
      page_size: number;
      has_more: boolean;
      next_cursor: string;
    };
    expect(page.page_size).toBe(2);
    expect(page.has_more).toBe(true);
    expect(page.next_cursor).toMatch(/^cs1_/);
  });

  it('OS-03: the cursor it hands back actually advances the list', async () => {
    // The minted cursor was never read back, so an agent that followed it got
    // page one again and orders beyond page_size were unreachable. payments
    // .search consumes `cursor`; this endpoint advertised one and ignored it.
    const first = await ask('orders_select', {}, AMAL);
    const page1 = first.result['page'] as { has_more: boolean; next_cursor: string };
    expect(page1.has_more).toBe(true);

    const second = await ask('orders_select', { cursor: page1.next_cursor }, AMAL);
    const refsOf = (a: DeskAnswer): string[] =>
      (a.result['candidates'] as Array<{ order_ref: string }>).map((c) => c.order_ref);
    expect(refsOf(second)).not.toEqual(refsOf(first));
    expect(refsOf(second).some((ref) => refsOf(first).includes(ref))).toBe(false);
  });

  it('OS-03: a currency it names in applied_filters is a currency it filtered on', async () => {
    // `currency` was only applied when `amount` was also supplied, but was
    // echoed into applied_filters either way — the response claimed a scope it
    // had not applied, and an agent reading it would believe the list narrowed.
    const answer = await ask('orders_select', { currency: 'USD' }, AMAL);
    const filters = answer.result['applied_filters'] as Record<string, unknown>;
    if (filters['currency'] !== undefined) {
      const candidates = answer.result['candidates'] as Array<{
        total: { currency: string };
      }>;
      for (const candidate of candidates) {
        expect(candidate.total.currency).toBe('USD');
      }
    }
  });

  it('OS-03: one visible row with more pages behind it is still not a selection', async () => {
    const narrowPage = (CS_DESK_BASELINE['policies'] ?? []).map((p) =>
      p['policy_key'] === 'order_picker'
        ? { ...p, value: { ...(p['value'] as object), page_size: 1 } }
        : p,
    );
    const answer = await ask('orders_select', {}, AMAL, { overrides: { policies: narrowPage } });
    expect((answer.result['candidates'] as unknown[]).length).toBe(1);
    expect((answer.result['page'] as { has_more: boolean }).has_more).toBe(true);
    expect(answer.result['selected_order_ref']).toBeNull();
    expect((answer.result['coverage'] as { complete: boolean }).complete).toBe(false);
  });

  it('OS-03: filters that match several orders are ambiguous, not candidates', async () => {
    const answer = await ask('orders_select', { merchant_hint: 'Panda' }, FAISAL);
    expect(answer.status).toBe('ambiguous');
    expect((answer.result['candidates'] as unknown[]).length).toBe(2);
    expect(answer.result['applied_filters']).toEqual({ merchant_hint: 'Panda' });
  });

  it('OS-04: an empty listing states its scope and reports complete coverage', async () => {
    const answer = await ask('orders_select', { merchant_hint: 'Nowhere' }, AMAL);
    expect(answer.status).toBe('no_match');
    expect((answer.result['coverage'] as { complete: boolean }).complete).toBe(true);
  });
});

// ============================================================================
// order.inspect — OI-F1/F2, OI-R1 … R10, OI-D1 … D4, OI-N2
// ============================================================================

describe('order.inspect', () => {
  const sectionsOf = (a: DeskAnswer) =>
    a.result['sections'] as Record<string, Record<string, unknown>>;
  const refundsOf = (a: DeskAnswer) =>
    (sectionsOf(a)['refund']?.['refunds'] ?? []) as Array<Record<string, unknown>>;

  it('OI-F1: an unresolvable reference describes that reference and no other order', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-9999' }, AMAL);
    expect(answer.status).toBe('not_found');
    expect(answer.errorRecovery?.code).toBe('not_found');
    expect(answer.result['sections']).toBeUndefined();
  });

  it('OI-F2: an unrelated section outage leaves the verified plan answer usable', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-1206' }, RANA);
    expect(answer.status).toBe('partial');
    expect(sectionsOf(answer)['claims']?.['availability']).toBe('unavailable');
    expect(sectionsOf(answer)['plan']?.['availability']).toBe('complete');
    expect(sectionsOf(answer)['plan']?.['outstanding_balance']).toEqual({
      amount: 750,
      currency: 'AED',
    });
    expect(answer.escalations).toEqual([]);
  });

  it('OI-R1: a complete lookup with no refund event, and an empty section that says so', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-1004' }, AMAL);
    expect(answer.status).toBe('complete');
    expect(sectionsOf(answer)['refund']?.['availability']).toBe('complete');
    expect(refundsOf(answer)).toEqual([]);
  });

  it('OI-R1: a settlement source that failed is not an order with no refund', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-1004' }, AMAL, {
      overrides: sourceFailed('settlement', ['refund']),
    });
    expect(answer.status).toBe('partial');
    expect(sectionsOf(answer)['refund']?.['availability']).toBe('unavailable');
    expect(sectionsOf(answer)['refund']?.['refunds']).toBeUndefined();
  });

  it('OI-R2: pending with the merchant inside the approved window', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-1001' }, AMAL);
    expect(answer.status).toBe('complete');
    const refund = refundsOf(answer)[0]!;
    expect(refund['state']).toBe('pending_merchant');
    expect(refund['owner']).toBe('merchant');
    expect(refund['timing_state']).toBe('within_window');
    expect(refund['expected_update_at']).toBeTruthy();
    expect(answer.escalations).toEqual([]);
  });

  it('OI-R3: past the window with policy requiring investigation, it escalates', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-1002' }, AMAL);
    expect(refundsOf(answer)[0]?.['timing_state']).toBe('overdue');
    expect(reasons(answer)).toEqual(['refund_failure']);
    expect(answer.escalations[0]?.scope).toBe('refund');
  });

  it('OI-R3: the deadline boundary is exact', async () => {
    const refund = (CS_DESK_BASELINE['refunds'] ?? []).find((r) => r['refund_ref'] === 'RFD-3001')!;
    const dueMs = Date.parse(refund['requested_at'] as string) + 14 * 86_400_000;
    const at = async (nowMs: number) =>
      callDesk(endpoints, {
        endpointId: 'order_inspect',
        body: { order_ref: 'ORD-1001' },
        personaId: AMAL,
        nowMs,
      });

    const onTheInstant = await at(dueMs);
    expect(
      (
        onTheInstant.result['sections'] as never as Record<
          string,
          { refunds: Array<{ timing_state: string }> }
        >
      )['refund']!.refunds[0]!.timing_state,
    ).toBe('within_window');
    const oneMillisecondLater = await at(dueMs + 1);
    expect(
      (
        oneMillisecondLater.result['sections'] as never as Record<
          string,
          { refunds: Array<{ timing_state: string }> }
        >
      )['refund']!.refunds[0]!.timing_state,
    ).toBe('overdue');
  });

  it('OI-R4: no approved deadline means unknown timing, never an invented one', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-1001' }, AMAL, {
      overrides: withoutPolicy('refund_deadlines'),
    });
    expect(answer.status).toBe('partial');
    const refund = refundsOf(answer)[0]!;
    expect(refund['timing_state']).toBe('unknown');
    expect(refund['expected_update_at']).toBeNull();
    expect(refund['state']).toBe('pending_merchant');
    expect(answer.errorRecovery?.code).toBe('policy_unresolved');
    expect(answer.escalations).toEqual([]);
  });

  it('OI-R4: overdue with no approved action reports the delay and blames nobody', async () => {
    const relaxed = (CS_DESK_BASELINE['refunds'] ?? []).map((r) =>
      r['refund_ref'] === 'RFD-3002' ? { ...r, investigation_required_when_overdue: false } : r,
    );
    const answer = await ask('order_inspect', { order_ref: 'ORD-1002' }, AMAL, {
      overrides: { refunds: relaxed },
    });
    expect(refundsOf(answer)[0]?.['timing_state']).toBe('overdue');
    expect(answer.escalations).toEqual([]);
    expect(answer.errorRecovery?.code).toBe('policy_unresolved');
  });

  it('OI-R5: a plan-only settlement is explained without any payment reference', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-1003' }, AMAL);
    expect(answer.status).toBe('complete');
    const refund = refundsOf(answer)[0]!;
    expect(refund['state']).toBe('processed');
    expect(refund['payment_ref']).toBeNull();
    expect(refund['resulting_balance']).toEqual({ amount: 0, currency: 'SAR' });
    const allocations = refund['allocations'] as Array<Record<string, unknown>>;
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.['destination']).toBe('plan');
  });

  it('OI-R6: a split settlement reports each leg with its own state', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-1203' }, RANA);
    expect(answer.status).toBe('complete');
    const allocations = refundsOf(answer)[0]?.['allocations'] as Array<Record<string, unknown>>;
    expect(allocations.map((a) => a['destination'])).toEqual(['plan', 'card']);
    expect(allocations[1]?.['trace_reference']).toBe('ARN-77120033');
    expect(answer.escalations).toEqual([]);
  });

  it('OI-R7: a failed leg escalates and the completed leg stays visible', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-1205' }, RANA);
    expect(reasons(answer)).toContain('refund_failure');
    const allocations = refundsOf(answer)[0]?.['allocations'] as Array<Record<string, unknown>>;
    expect(allocations.find((a) => a['destination'] === 'plan')?.['state']).toBe('processed');
    expect(allocations.find((a) => a['destination'] === 'card')?.['state']).toBe('failed');
  });

  it('OI-R8: an unreconciled external leg points at the payment that can resolve it', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-1204' }, RANA);
    expect(answer.status).toBe('partial');
    expect(refundsOf(answer)[0]?.['payment_ref']).toBe('PAY-2201');
    expect(answer.errorRecovery?.message).toContain('PAY-2201');
    expect(answer.escalations).toEqual([]);
  });

  it('OI-R8: with no linked payment there is nothing to resolve it, so it escalates', async () => {
    const orphaned = (CS_DESK_BASELINE['refunds'] ?? []).map((r) =>
      r['refund_ref'] === 'RFD-3204' ? { ...r, payment_ref: null } : r,
    );
    const answer = await ask('order_inspect', { order_ref: 'ORD-1204' }, RANA, {
      overrides: { refunds: orphaned },
    });
    expect(reasons(answer)).toEqual(['conflicting_data']);
  });

  it('OI-R9: a merchant block with an existing claim reuses it', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-1201' }, RANA);
    expect(refundsOf(answer)[0]?.['state']).toBe('merchant_blocked');
    const existing = sectionsOf(answer)['claims']?.['existing'] as Array<Record<string, unknown>>;
    expect(existing.map((c) => c['claim_ref'])).toEqual(['CLM-4201']);
    expect(answer.escalations).toEqual([]);
  });

  it('OI-R10: a merchant block with complete coverage and no claim escalates', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-1202' }, RANA);
    expect(reasons(answer)).toEqual(['merchant_blocked_refund']);
  });

  it('OI-R10: a claim service that did not answer does not establish there is no claim', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-1202' }, RANA, {
      overrides: sourceFailed('claims', ['claims']),
    });
    expect(reasons(answer)).not.toContain('merchant_blocked_refund');
    expect(answer.status).toBe('partial');
  });

  it('OI-D1: a final credit decision explains itself and promises no override', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-1101' }, FAISAL);
    const decline = sectionsOf(answer)['decline']!;
    expect(decline['classification']).toBe('explainable');
    expect((decline['retry'] as Record<string, unknown>)['state']).toBe('blocked');
    expect(answer.escalations).toEqual([]);
  });

  it('OI-D2: a technical decline below its threshold reports the retry and does not escalate', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-1102' }, FAISAL);
    const decline = sectionsOf(answer)['decline']!;
    expect(decline['classification']).toBe('technical');
    const retry = decline['retry'] as Record<string, unknown>;
    expect(retry['condition_key']).toBe('retry_after_elapsed');
    expect(retry['condition_satisfied']).toBe(true);
    expect(answer.escalations).toEqual([]);
  });

  it('OI-D3: the same code at its threshold escalates', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-1103' }, FAISAL);
    expect(reasons(answer)).toEqual(['technical_investigation']);
    expect(answer.escalations[0]?.scope).toBe('decline');
  });

  it('OI-D4: an unmapped code needs a human and says so', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-1104' }, FAISAL);
    expect(sectionsOf(answer)['decline']?.['classification']).toBe('unknown');
    expect(reasons(answer)).toEqual(['unknown_decline_code']);
  });

  it('OI-D4: an unmapped code differs from a mapping service that did not answer', async () => {
    const answer = await ask('order_inspect', { order_ref: 'ORD-1104' }, FAISAL, {
      overrides: sourceFailed('decline_map', ['decline_codes']),
    });
    expect(sectionsOf(answer)['decline']?.['availability']).toBe('unavailable');
    expect(sectionsOf(answer)['decline']?.['classification']).toBeUndefined();
    expect(answer.escalations).toEqual([]);
  });

  it('OI-N2: a bounded section pages, and the cursor stays bound to its order', async () => {
    const firstPage = await ask('order_inspect', { order_ref: 'ORD-1004' }, AMAL);
    const plan = sectionsOf(firstPage)['plan']!;
    expect((plan['instalments'] as unknown[]).length).toBe(2);
    expect(plan['has_more']).toBe(true);

    const cursor = plan['section_cursor'] as string;
    const second = await ask(
      'order_inspect',
      { order_ref: 'ORD-1004', section_cursor: cursor },
      AMAL,
    );
    const nextPlan = sectionsOf(second)['plan']!;
    expect(
      (nextPlan['instalments'] as Array<Record<string, unknown>>).map((i) => i['instalment_ref']),
    ).toEqual(['INS-1004-3', 'INS-1004-4']);
    expect(nextPlan['has_more']).toBe(false);
    // The outstanding balance is the whole plan, never just the visible page.
    expect(nextPlan['outstanding_balance']).toEqual({ amount: 375, currency: 'SAR' });

    const wrongOrder = await ask(
      'order_inspect',
      { order_ref: 'ORD-1001', section_cursor: cursor },
      AMAL,
    );
    expect(wrongOrder.errorRecovery?.code).toBe('invalid_cursor');
  });
});

// ============================================================================
// payments.search — PS-01 … PS-09
// ============================================================================

const OMAR = 'cus_sa_omar';
const WINDOW = { occurred_from: '2026-09-01', occurred_to: '2026-09-10' };

describe('payments.search', () => {
  it('PS-01: a malformed bound is invalid input and nothing was queried', async () => {
    const answer = await ask(
      'payments_search',
      { occurred_from: 'last Tuesday', occurred_to: '2026-09-10' },
      FAISAL,
    );
    expect(answer.status).toBe('invalid_input');
    expect(answer.result['query_executed']).toBe(false);
    expect(answer.errorRecovery?.missing_fields).toEqual(['occurred_from']);
    expect(answer.result['candidates']).toBeUndefined();
  });

  it('PS-01: bounds of mixed precision are refused', async () => {
    const answer = await ask(
      'payments_search',
      { occurred_from: '2026-09-01', occurred_to: '2026-09-10T12:00:00+03:00' },
      FAISAL,
    );
    expect(answer.status).toBe('invalid_input');
    expect(answer.errorRecovery?.message).toContain('same precision');
  });

  it('PS-01: a datetime without an offset is not a datetime', async () => {
    const answer = await ask(
      'payments_search',
      { occurred_from: '2026-09-01T00:00:00', occurred_to: '2026-09-10T00:00:00' },
      FAISAL,
    );
    expect(answer.status).toBe('invalid_input');
  });

  it('PS-01: a window that ends before it starts, and one past the approved maximum', async () => {
    const reversed = await ask(
      'payments_search',
      { occurred_from: '2026-09-10', occurred_to: '2026-09-01' },
      FAISAL,
    );
    expect(reversed.errorRecovery?.message).toContain('ends before it starts');

    const tooWide = await ask(
      'payments_search',
      { occurred_from: '2026-01-01', occurred_to: '2026-09-10' },
      FAISAL,
    );
    expect(tooWide.errorRecovery?.message).toContain('90 days');
  });

  it('PS-02: assurance is a platform fact, and a card fragment never raises it', async () => {
    const answer = await ask('payments_search', { ...WINDOW, last_four: '7711' }, OMAR);
    expect(answer.status).toBe('verification_required');
    expect(answer.result['candidates']).toBeUndefined();
    expect(answer.result['query_executed']).toBe(false);
  });

  it('PS-04 / PS-09: candidates page, and the cursor continues the same search', async () => {
    const firstPage = await ask('payments_search', WINDOW, FAISAL);
    expect(firstPage.status).toBe('matches');
    const page = firstPage.result['page'] as {
      page_size: number;
      has_more: boolean;
      next_cursor: string;
    };
    expect(page.page_size).toBe(2);
    expect(page.has_more).toBe(true);
    expect(
      (firstPage.result['coverage'] as { complete_for_scope: boolean }).complete_for_scope,
    ).toBe(true);

    const second = await ask('payments_search', { cursor: page.next_cursor }, FAISAL);
    expect(second.status).toBe('matches');
    const firstRefs = (firstPage.result['candidates'] as Array<{ payment_ref: string }>).map(
      (c) => c.payment_ref,
    );
    const secondRefs = (second.result['candidates'] as Array<{ payment_ref: string }>).map(
      (c) => c.payment_ref,
    );
    expect(secondRefs.some((r) => firstRefs.includes(r))).toBe(false);
  });

  it("PS-03: another account's cursor is refused without echoing its filters", async () => {
    const mine = await ask('payments_search', WINDOW, FAISAL);
    const cursor = (mine.result['page'] as { next_cursor: string }).next_cursor;
    const stolen = await ask('payments_search', { cursor }, AMAL);
    expect(stolen.status).toBe('cursor_expired');
    expect(stolen.errorRecovery?.code).toBe('invalid_cursor');
    expect(stolen.result['applied_scope']).toBeUndefined();
  });

  it('PS-03: an expired cursor returns the scope, because re-issuing it is the only fix', async () => {
    const mine = await ask('payments_search', WINDOW, FAISAL);
    const cursor = (mine.result['page'] as { next_cursor: string }).next_cursor;
    const later = await callDesk(endpoints, {
      endpointId: 'payments_search',
      body: { cursor },
      personaId: FAISAL,
      nowMs: NOW + 3_600_000,
    });
    expect(later.status).toBe('cursor_expired');
    expect(later.errorRecovery?.code).toBe('cursor_expired');
    expect(later.result['applied_scope']).toMatchObject(WINDOW);
  });

  it('PS-05: sources that disagree produce a conflict, never a no-match', async () => {
    const answer = await ask(
      'payments_search',
      { occurred_from: '2026-01-01', occurred_to: '2026-01-05' },
      FAISAL,
      {
        overrides: {
          source_health: [
            {
              source_key: 'payments_index',
              state: 'conflict',
              as_of: null,
              recheck_at: null,
              retryable: true,
              applies_to: ['payments_search'],
            },
          ],
        },
      },
    );
    expect(answer.status).toBe('conflict');
    expect(reasons(answer)).toEqual(['conflicting_data']);
  });

  it('PS-06: a failed source is unavailable and retryable; unsupported retention is not', async () => {
    const failed = await ask(
      'payments_search',
      { occurred_from: '2026-01-01', occurred_to: '2026-01-05' },
      FAISAL,
      {
        overrides: sourceFailed('payments_index', ['payments_search']),
      },
    );
    expect(failed.status).toBe('unavailable');
    expect(failed.errorRecovery?.retryable).toBe(true);
    expect(failed.escalations).toEqual([]);

    const notCovered = await ask(
      'payments_search',
      { occurred_from: '2026-01-01', occurred_to: '2026-01-05' },
      FAISAL,
      {
        overrides: {
          source_health: [
            {
              source_key: 'payments_index',
              state: 'not_covered',
              as_of: null,
              recheck_at: null,
              retryable: false,
              applies_to: ['payments_search'],
            },
          ],
        },
      },
    );
    expect(notCovered.status).toBe('unavailable');
    expect(notCovered.errorRecovery?.retryable).toBe(false);
    expect(reasons(notCovered)).toEqual(['capability_unavailable']);
  });

  it('PS-07: an evidenced lag is awaiting refresh, with a real recheck time', async () => {
    const answer = await ask(
      'payments_search',
      { occurred_from: '2026-01-01', occurred_to: '2026-01-05' },
      FAISAL,
      {
        overrides: {
          source_health: [
            {
              source_key: 'payments_index',
              state: 'lagging',
              as_of: new Date(NOW - 3_600_000).toISOString(),
              recheck_at: new Date(NOW + 1_800_000).toISOString(),
              retryable: true,
              applies_to: ['payments_search'],
            },
          ],
        },
      },
    );
    expect(answer.status).toBe('awaiting_source_refresh');
    expect((answer.result['coverage'] as { recheck_at: string }).recheck_at).toBeTruthy();
  });

  it('PS-08: a complete zero-result search carries the evidence a review would need', async () => {
    const answer = await ask(
      'payments_search',
      { occurred_from: '2026-01-01', occurred_to: '2026-01-05' },
      FAISAL,
    );
    expect(answer.status).toBe('no_match');
    expect(answer.result['query_executed']).toBe(true);
    expect((answer.result['coverage'] as { complete_for_scope: boolean }).complete_for_scope).toBe(
      true,
    );
    expect(answer.result['evidence_requirements']).toEqual(['bank_statement']);
    expect(answer.result['review_reasons']).toContain('unrecognized_charge_review');
  });

  it('reads no payment at all for a caller acting as nobody', async () => {
    const answer = await ask('payments_search', WINDOW, null);
    expect(answer.status).toBe('verification_required');
  });
});

// ============================================================================
// payment.inspect — PI-F1, PI-01 … PI-11, PI-N1
// ============================================================================

describe('payment.inspect', () => {
  const inspect = (ref: string, persona: string, over = {}) =>
    ask('payment_inspect', { payment_ref: ref }, persona, over);
  const sectionsOf = (a: DeskAnswer) =>
    a.result['sections'] as Record<string, Record<string, unknown>>;

  it('PI-F1: an unresolved reference on this account', async () => {
    const answer = await inspect('PAY-0000', FAISAL);
    expect(answer.status).toBe('not_found');
  });

  it('PI-01: capture and application reconcile, and the linked order is named', async () => {
    const answer = await inspect('PAY-2102', FAISAL);
    expect(answer.status).toBe('complete');
    expect(answer.result['classification']).toBe('reflected');
    // PI-N1 — the reference that makes a further read possible.
    const linked = sectionsOf(answer)['obligations']?.['linked_obligations'] as Array<
      Record<string, unknown>
    >;
    expect(linked[0]?.['order_ref']).toBe('ORD-1105');
    expect(linked[0]?.['state']).toBe('applied');
    expect(answer.escalations).toEqual([]);
  });

  it('PI-02: a verified hold, not merely an attempt', async () => {
    const answer = await inspect('PAY-2103', FAISAL);
    expect(answer.result['classification']).toBe('authorization_hold');
    expect(answer.escalations).toEqual([]);
  });

  it('PI-03: a provider reversal is reported with the bank fact kept separate', async () => {
    const answer = await inspect('PAY-2109', FAISAL);
    expect(answer.result['classification']).toBe('reversal');
    expect(sectionsOf(answer)['bank_state']?.['reversal']).toBe('confirmed');
  });

  it('PI-04: a duplicate whose correction is already complete proposes none', async () => {
    const corrected = (CS_DESK_BASELINE['payments'] ?? []).map((p) =>
      p['payment_ref'] === 'PAY-2105'
        ? {
            ...p,
            remediation: {
              state: 'completed',
              amount: { amount: 120, currency: 'SAR' },
              expected_by: null,
              reference: 'RFD-3101',
            },
          }
        : p,
    );
    const answer = await inspect('PAY-2105', FAISAL, { overrides: { payments: corrected } });
    expect(answer.result['classification']).toBe('duplicate_capture');
    expect(answer.escalations).toEqual([]);
  });

  it('PI-05: a correction in flight suppresses a second one, however often it is asked', async () => {
    const first = await inspect('PAY-2105', FAISAL);
    const again = await inspect('PAY-2105', FAISAL);
    for (const answer of [first, again]) {
      expect(answer.result['classification']).toBe('remediation_in_progress');
      expect(answer.escalations).toEqual([]);
      expect(
        (sectionsOf(answer)['reconciliation']?.['remediation'] as { state: string }).state,
      ).toBe('pending');
    }
  });

  it('PI-06: a verified extra capture with no correction anywhere needs a human', async () => {
    const answer = await inspect('PAY-2106', FAISAL);
    expect(answer.result['classification']).toBe('duplicate_capture');
    expect(reasons(answer)).toEqual(['technical_investigation']);
  });

  it('PI-07: a lag evidenced against this payment blocks the conclusion', async () => {
    const answer = await inspect('PAY-2110', FAISAL);
    expect(answer.status).toBe('partial');
    expect(answer.result['classification']).toBe('waiting_for_refresh');
    const reconciliation = sectionsOf(answer)['reconciliation']!;
    expect(reconciliation['application_state']).toBe('unassessable');
    expect((reconciliation['coverage'] as { recheck_at: string }).recheck_at).toBeTruthy();
    expect(answer.escalations).toEqual([]);
  });

  it('PI-08: KSA wallet eligibility answers before the generic reading', async () => {
    const answer = await inspect('PAY-2111', FAISAL);
    expect(answer.result['classification']).toBe('eligible_for_wallet_refund');
    expect(reasons(answer)).toEqual(['payment_not_reflected']);
    expect(sectionsOf(answer)['reconciliation']?.['supporting_references']).toContain('ELIG-9001');
  });

  it('PI-08: without the market rule the same evidence is PI-09, not a wallet refund', async () => {
    const answer = await inspect('PAY-2111', FAISAL, { overrides: withoutPolicy('wallet_refund') });
    expect(answer.result['classification']).toBe('captured_not_reflected');
    expect(reasons(answer)).toEqual(['technical_investigation']);
  });

  it('PI-09: captured and never applied, on complete evidence', async () => {
    const answer = await inspect('PAY-2101', FAISAL);
    expect(answer.result['classification']).toBe('captured_not_reflected');
    expect(reasons(answer)).toEqual(['technical_investigation']);
  });

  it('PI-09: with no approved correction policy the conclusion is withheld', async () => {
    const answer = await inspect('PAY-2101', FAISAL, {
      overrides: withoutPolicy('reconciliation'),
    });
    expect(answer.status).toBe('partial');
    expect(answer.result['classification']).toBeUndefined();
    expect(answer.errorRecovery?.code).toBe('policy_unresolved');
    expect(answer.escalations).toEqual([]);
  });

  it('PI-10: a failed settlement leg on a linked refund escalates', async () => {
    const answer = await inspect('PAY-2204', RANA);
    expect(reasons(answer)).toContain('refund_failure');
    const refunds = sectionsOf(answer)['refunds']?.['refunds'] as Array<Record<string, unknown>>;
    const allocations = refunds[0]?.['allocations'] as Array<Record<string, unknown>>;
    expect(allocations.find((a) => a['destination'] === 'plan')?.['state']).toBe('processed');
  });

  it('PI-11: declined does not imply the bank never took the money', async () => {
    const answer = await inspect('PAY-2108', FAISAL);
    expect(answer.result['classification']).toBe('declined_reversal_unconfirmed');
    expect(sectionsOf(answer)['bank_state']?.['debit']).toBe('confirmed');
    expect(sectionsOf(answer)['bank_state']?.['reversal']).toBe('pending');
  });

  it('a ledger that did not answer leaves the payment unassessable, not unapplied', async () => {
    const answer = await inspect('PAY-2101', FAISAL, {
      overrides: sourceFailed('ledger', ['payment_inspect', 'reconciliation']),
    });
    expect(answer.status).toBe('partial');
    expect(answer.result['classification']).toBeUndefined();
    expect(sectionsOf(answer)['reconciliation']?.['application_state']).toBe('unassessable');
    expect(answer.escalations).toEqual([]);
  });
});

// ============================================================================
// handover.start — HS-01 … HS-08
// ============================================================================

describe('handover.start', () => {
  const transfer = {
    reason: 'technical_investigation',
    customer_goal: 'find out why the payment never reached the plan',
    summary: 'PAY-2101 was captured and never applied.',
    attempted_actions: ['payment_inspect'],
  };

  it('HS-01: a reference from another account is refused and nothing about it is sent', async () => {
    const answer = await ask('handover_start', { ...transfer, order_refs: ['ORD-1201'] }, FAISAL);
    expect(answer.status).toBe('rejected');
    expect(answer.errorRecovery?.code).toBe('access_denied');
    expect(answer.result['case_ref']).toBeNull();
    expect(answer.mutations).toEqual([]);
  });

  it('HS-02: no authenticated account routes to secure intake and creates no case', async () => {
    const answer = await ask('handover_start', transfer, null);
    expect(answer.status).toBe('started');
    expect(answer.result['queue']).toBe('secure_intake');
    expect(answer.result['case_ref']).toBeNull();
    expect(answer.mutations).toEqual([]);
  });

  it('HS-02: an unverified account transfers the outcome and no account detail', async () => {
    const answer = await ask(
      'handover_start',
      { ...transfer, summary: 'unrecognised debit' },
      OMAR,
    );
    expect(answer.status).toBe('started');
    expect(answer.result['queue']).toBe('secure_intake');
    expect(answer.mutations).toHaveLength(1);
    expect(answer.mutations[0]?.collection).toBe('handover_cases');
  });

  it('HS-03: a duplicate call reports the case that exists and opens no second one', async () => {
    const existing = [
      {
        case_ref: 'CASE-EXISTING',
        customer_id: FAISAL,
        reason: 'technical_investigation',
        queue: 'payments_engineering',
        state: 'active',
        created_at: new Date(NOW - 60_000).toISOString(),
        idempotency_key: 'idem-1',
        customer_goal: 'x',
        summary: 'y',
        automation_locked: true,
        evidence_state: 'not_required',
      },
    ];
    const answer = await ask('handover_start', { ...transfer, idempotency_key: 'idem-1' }, FAISAL, {
      overrides: { handover_cases: existing },
    });
    expect(answer.status).toBe('already_active');
    expect(answer.result['case_ref']).toBe('CASE-EXISTING');
    expect(answer.result['automation_locked']).toBe(true);
    expect(answer.mutations).toEqual([]);
  });

  it('HS-04: a route needing confirmation waits for it, and asking is not confirming', async () => {
    const asking = await ask(
      'handover_start',
      { ...transfer, reason: 'customer_requested_human' },
      FAISAL,
    );
    expect(asking.status).toBe('confirmation_required');
    expect(asking.mutations).toEqual([]);

    const confirmed = await ask(
      'handover_start',
      { ...transfer, reason: 'customer_requested_human', customer_confirmed: true },
      FAISAL,
    );
    expect(confirmed.status).toBe('started');
    expect(confirmed.result['queue']).toBe('general_support');
  });

  it('HS-05: out of hours executes only the approved fallback and claims no live transfer', async () => {
    const answer = await callDesk(endpoints, {
      endpointId: 'handover_start',
      body: transfer,
      personaId: FAISAL,
      nowMs: Date.parse('2026-09-10T02:00:00.000Z'),
    });
    expect(answer.status).toBe('out_of_hours');
    expect(answer.result['automation_locked']).toBe(false);
    expect(answer.result['reopens_at']).toBeTruthy();
    // The approved policy for this market queues the case; it does not claim
    // anybody picked it up.
    expect(answer.mutations).toHaveLength(1);
  });

  it('HS-06: an accepted transfer locks automation and records the case', async () => {
    const answer = await ask('handover_start', transfer, FAISAL);
    expect(answer.status).toBe('started');
    expect(answer.result['automation_locked']).toBe(true);
    expect(answer.result['queue']).toBe('payments_engineering');
    expect(answer.mutations).toHaveLength(1);
    expect(answer.mutations[0]?.op).toBe('create');
  });

  it('HS-06: the mandatory evidence gate is enforced, and partial evidence is reported as partial', async () => {
    const none = await ask(
      'handover_start',
      { ...transfer, reason: 'unrecognized_charge_review' },
      FAISAL,
    );
    expect(none.status).toBe('rejected');
    expect((none.result['evidence'] as { state: string; missing_types: string[] }).state).toBe(
      'pending',
    );
    expect((none.result['evidence'] as { missing_types: string[] }).missing_types).toEqual([
      'bank_statement',
    ]);
    expect(none.mutations).toEqual([]);

    const wrongType = await ask(
      'handover_start',
      { ...transfer, reason: 'unrecognized_charge_review', evidence_refs: ['selfie:abc'] },
      FAISAL,
    );
    expect((wrongType.result['evidence'] as { state: string }).state).toBe('partial');
    expect(wrongType.status).toBe('rejected');

    const complete = await ask(
      'handover_start',
      {
        ...transfer,
        reason: 'unrecognized_charge_review',
        evidence_refs: ['bank_statement:doc-1'],
      },
      FAISAL,
    );
    expect(complete.status).toBe('started');
    expect((complete.result['evidence'] as { state: string }).state).toBe('attached');
  });

  it('HS-07: a definitive refusal is a failure with a stated retry budget', async () => {
    const answer = await ask('handover_start', transfer, FAISAL, {
      overrides: {
        source_health: [
          {
            source_key: 'handover',
            state: 'failed',
            as_of: null,
            recheck_at: null,
            retryable: false,
            applies_to: ['handover_start'],
          },
        ],
      },
    });
    expect(answer.status).toBe('failed');
    expect(answer.result['automation_locked']).toBe(false);
    expect(answer.errorRecovery?.retryable).toBe(false);
    expect(answer.mutations).toEqual([]);
  });

  it('HS-08: a timeout leaves the outcome unknown and refuses to re-submit', async () => {
    const answer = await ask('handover_start', transfer, FAISAL, {
      overrides: {
        source_health: [
          {
            source_key: 'handover',
            state: 'lagging',
            as_of: null,
            recheck_at: null,
            retryable: true,
            applies_to: ['handover_start'],
          },
        ],
      },
    });
    expect(answer.status).toBe('unavailable');
    expect(answer.errorRecovery?.code).toBe('transfer_state_unknown');
    expect(answer.errorRecovery?.retryable).toBe(false);
    expect(answer.mutations).toEqual([]);
  });
});
