import type { SimulationCodeHandler } from '@aflow/schemas';
import { CLAIM_INSPECT } from './claimInspect.js';
import { HANDOVER_START } from './handoverStart.js';
import { ORDER_INSPECT } from './orderInspect.js';
import { ORDERS_SELECT } from './ordersSelect.js';
import { PAYMENT_INSPECT } from './paymentInspect.js';
import { PAYMENTS_SEARCH } from './paymentsSearch.js';
import { KNOWLEDGE_SEARCH } from './knowledgeSearch.js';
import { CS_DESK_PRELUDE } from './prelude.js';

/**
 * Every handler is the shared prelude followed by its own decision table.
 *
 * `collections` is not a convenience list — it is the only thing a readiness
 * report can know about an endpoint whose body is opaque, so an endpoint that
 * reads a collection has to name it or the world looks unread.
 */
function handler(collections: string[], body: string): SimulationCodeHandler {
  return { collections, code: CS_DESK_PRELUDE + body, timeoutMs: 1_000 };
}

export const CS_DESK_HANDLERS: Record<string, SimulationCodeHandler> = {
  knowledge_search: handler(
    ['customers', 'knowledge_articles', 'policies', 'source_health'],
    KNOWLEDGE_SEARCH,
  ),
  claim_inspect: handler(['customers', 'claims', 'policies', 'source_health'], CLAIM_INSPECT),
  orders_select: handler(['customers', 'orders', 'policies', 'source_health'], ORDERS_SELECT),
  order_inspect: handler(
    [
      'customers',
      'orders',
      'instalments',
      'refunds',
      'claims',
      'decline_codes',
      'policies',
      'source_health',
    ],
    ORDER_INSPECT,
  ),
  payments_search: handler(['customers', 'payments', 'policies', 'source_health'], PAYMENTS_SEARCH),
  payment_inspect: handler(
    ['customers', 'payments', 'refunds', 'policies', 'source_health'],
    PAYMENT_INSPECT,
  ),
  handover_start: handler(
    ['customers', 'orders', 'payments', 'claims', 'handover_cases', 'policies', 'source_health'],
    HANDOVER_START,
  ),
};
