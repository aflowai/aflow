import { describe, expect, it } from 'vitest';
import { type ComposedLanes, MAX_PINNED_TOOLS } from '@aflow/schemas';
import { resolveHelmsmanCapabilities, estimateOperationTokens } from './helmsmanCapabilities.js';
const local: ComposedLanes = {
  edition: 'community-local',
  hostLane: 'present',
  browserLane: 'present',
  codeLane: 'absent',
};

describe('Helmsman capability resolution', () => {
  it('prices the actual local defaults and keeps only the steering memory and skill reads pinned', () => {
    const result = resolveHelmsmanCapabilities(local);
    expect(result.coreOperations).toContain('host.harness.run');
    expect(result.coreOperations).toContain('workflow.manage.get');
    expect(result.coreOperations).toContain('catalog.skill.search');
    for (const id of [
      'memory.store.put',
      'memory.context.remember',
      'ui.artifact.render',
      'workflow.campaign.get',
    ]) {
      expect(result.coreOperations).not.toContain(id);
      expect(result.discoverableOperationIds).toContain(id);
    }
    expect(result.pinnedTokens).toBe(
      result.coreOperations.reduce((n, id) => n + estimateOperationTokens(id), 0),
    );
    expect(result.pinnedCount).toBeLessThan(MAX_PINNED_TOOLS);
  });
  it('does not offer an absent lane or an operation outside a custom ceiling', () => {
    const result = resolveHelmsmanCapabilities(local, {
      helmsmanOperations: ['code.agent.run', 'memory.store.delete'],
    });
    expect(result.discoverableOperationIds).toEqual(['memory.store.delete']);
    expect(result.bundles.find((b) => b.id === 'integrations')).toBeUndefined();
    expect(result.bundles.flatMap((b) => b.operations.map((o) => o.operationId))).not.toContain(
      'code.agent.run',
    );
  });
  it('pins a whole explicitly selected bundle and retains a mandatory output reader when memory is off', () => {
    const result = resolveHelmsmanCapabilities(local, {
      bundlePlacements: { memory_write: 'always_on', memory_read: 'off' },
    });
    const writes = result.bundles.find((b) => b.id === 'memory_write')!.operations;
    expect(writes.every((o) => result.coreOperations.includes(o.operationId))).toBe(true);
    expect(result.coreOperations).not.toContain('memory.store.get');
    expect(result.coreOperations.some((id) => id.startsWith('memory.run_output.'))).toBe(true);
  });
  it('allows smaller operation choices while off at group level revokes every member', () => {
    const selected = resolveHelmsmanCapabilities(local, {
      operationPlacements: { 'memory.store.put': 'always_on' },
    });
    expect(selected.coreOperations).toContain('memory.store.put');
    expect(selected.coreOperations).not.toContain('memory.store.delete');
    const off = resolveHelmsmanCapabilities(local, {
      bundlePlacements: { memory_write: 'off' },
      operationPlacements: { 'memory.store.put': 'always_on' },
    });
    expect(off.coreOperations).not.toContain('memory.store.put');
    expect(off.offOperationIds.has('memory.store.put')).toBe(true);
    expect(off.discoverableOperationIds).not.toContain('memory.store.put');
  });
});
