import { describe, expect, it } from 'vitest';
import { applyCapabilitySettings, withPromotedToolsRevoked } from './capabilityShedding.js';
import type { CatalogConfig } from '@aflow/schemas';
import type { VirtualToolEntry } from './agentTurn.js';

describe('placement revocation', () => {
  it('revokes an already-promoted write without removing reads in its capability group', () => {
    const catalog: CatalogConfig = {
      coreOperations: ['memory.store.get'],
      discovery: { allowedOperationIds: ['memory.store.put'] },
    };
    const settings = applyCapabilitySettings(catalog, {
      capabilityDiscovery: { bundlePlacements: { memory_write: 'off' } },
    });
    const promoted = Object.fromEntries(
      ['memory.store.get', 'memory.store.put'].map((id) => [
        id,
        { kind: 'operation', discoveredAtTurn: 1 },
      ]),
    ) as Record<string, VirtualToolEntry>;
    const remaining = withPromotedToolsRevoked(promoted, settings.shedOperationIds, undefined);
    expect(Object.keys(remaining ?? {})).toEqual(['memory.store.get']);
    expect(settings.catalogConfig?.discovery?.allowedOperationIds).not.toContain(
      'memory.store.put',
    );
    expect(settings.catalogConfig?.discovery?.excludeOperationIds).toContain('memory.store.put');
  });
});
