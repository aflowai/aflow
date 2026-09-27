import { describe, it, expect } from 'vitest';
import { effectiveWriteRiskTier } from '@aflow/schemas';
import { listConnectorCatalog } from '../connectorCatalog/index.js';

/**
 * Plan 253 §P1 guard: a write endpoint must never rely on the derived default
 * for its risk tier. `effectiveWriteRiskTier` defaults an untiered mutating
 * method to `low` (unattended) — safe against silent high-risk exposure, but a
 * real write endpoint must be classified deliberately, not left to the default.
 */
describe('connector write-risk tiers (Plan 253)', () => {
  it('every non-GET/HEAD endpoint declares an explicit writeRiskTier', () => {
    const offenders: string[] = [];
    for (const connector of listConnectorCatalog()) {
      for (const ep of connector.definition.endpoints) {
        const isRead = ep.method === 'GET' || ep.method === 'HEAD';
        if (!isRead && ep.writeRiskTier === undefined) {
          offenders.push(`${connector.catalogId}/${ep.endpointId} (${ep.method})`);
        }
      }
    }
    expect(
      offenders,
      `non-GET endpoints missing an explicit writeRiskTier:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('a GET/HEAD endpoint resolves to the read tier', () => {
    for (const connector of listConnectorCatalog()) {
      for (const ep of connector.definition.endpoints) {
        if (ep.method === 'GET' || ep.method === 'HEAD') {
          expect(effectiveWriteRiskTier(ep)).toBe('read');
        }
      }
    }
  });
});
