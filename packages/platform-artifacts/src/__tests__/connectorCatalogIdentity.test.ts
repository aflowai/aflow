import { describe, expect, it } from 'vitest';

import { CONNECTOR_CATALOG } from '../connectorCatalog/index.js';
import { STORE_CATALOG, curatedIntegrationIcon } from '../storeCatalog/index.js';

/**
 * A curated connector's id is **platform-owned**: `github` names one specific
 * vetted definition, and install registers that definition verbatim under the
 * same id. That is what lets `curatedIntegrationIcon` answer from an id alone —
 * no provenance lookup, no per-space row.
 *
 * The agreement is not expressible in `ConnectorCatalogEntrySchema`, and it fails
 * *silently*: a drifted entry doesn't error, its artwork just reverts to an
 * initials tile, which no reviewer catches. So it is pinned here.
 */
describe('connector catalog identity', () => {
  it('declares every API connector definition under its own catalogId', () => {
    const drifted = CONNECTOR_CATALOG.filter(
      (entry) => entry.definition.apiId !== entry.catalogId,
    ).map((entry) => `${entry.catalogId} → definition.apiId=${entry.definition.apiId}`);

    expect(drifted).toEqual([]);
  });

  it('declares every store connector listing under its own catalogId', () => {
    const drifted: string[] = [];
    for (const entry of STORE_CATALOG) {
      if (entry.kind !== 'connector') continue;
      const definition = entry.payload.definition as { apiId?: string; serverId?: string };
      const declaredId = definition.apiId ?? definition.serverId;
      if (declaredId !== entry.catalogId) {
        drifted.push(`${entry.catalogId} → definition id=${String(declaredId)}`);
      }
    }

    expect(drifted).toEqual([]);
  });

  it('resolves a curated default from the id an installed integration reports', () => {
    expect(curatedIntegrationIcon('github')).toEqual({ kind: 'brand', assetId: 'github' });
  });

  it('has no curated default for a hand-authored integration', () => {
    // Not a gap: such a definition carries its own `icon` if it wants artwork,
    // and otherwise gets the deterministic initials tile.
    expect(curatedIntegrationIcon('my-internal-api')).toBeUndefined();
  });
});
