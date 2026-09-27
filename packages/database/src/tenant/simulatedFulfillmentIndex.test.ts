import { describe, it, expect } from 'vitest';
import {
  SIMULATED_BINDING_EXPRESSION,
  SIMULATED_EVENT_PREDICATE,
  SIMULATED_FULFILLMENT_INDEX_NAME,
  simulatedFulfillmentIndexDdl,
} from './simulatedFulfillmentIndex.js';

describe('simulated fulfillment index', () => {
  it('builds the index from the same two expressions the reader filters on', () => {
    const ddl = simulatedFulfillmentIndexDdl('t_test');
    expect(ddl).toContain(SIMULATED_FULFILLMENT_INDEX_NAME);
    expect(ddl).toContain(SIMULATED_BINDING_EXPRESSION);
    expect(ddl).toContain(`WHERE ${SIMULATED_EVENT_PREDICATE}`);
  });

  it('is partial, so it indexes the events carrying the flag rather than the log', () => {
    // Without the WHERE, this is an index over every event ever written —
    // the cost the read exists to avoid, moved to write time.
    expect(simulatedFulfillmentIndexDdl('t_test')).toMatch(/WHERE\s+\(envelope/);
  });

  it('leaves `envelope` unqualified so the predicate matches a qualified query', () => {
    // Postgres normalizes both to the same column reference. A table prefix
    // here would still create a working index and still match — but the
    // expression is shared with a query that names the table, and only the
    // unqualified form is valid in both.
    expect(SIMULATED_EVENT_PREDICATE).not.toContain('event_log.');
    expect(SIMULATED_BINDING_EXPRESSION).not.toContain('event_log.');
  });

  it('scopes the index to the schema it is created in', () => {
    expect(simulatedFulfillmentIndexDdl('t_abc')).toContain('"t_abc".event_log');
  });
});
