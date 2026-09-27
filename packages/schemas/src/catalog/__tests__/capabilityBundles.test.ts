import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_BUNDLES,
  bundleForCapabilityGroup,
  bundleForOperation,
  bundlesForSurface,
  capabilityGroupsForBundles,
  getCapabilityBundle,
  shedableBundleIds,
  applyBundlePlacements,
  validateBundlePlacements,
  effectivePlacement,
  defaultPlacement,
  MAX_PINNED_TOOLS,
} from '../capabilityBundles.js';
import { getAllOperations } from '../registry.js';

/**
 * Every (capability group, access mode) pair an agent could hold a tool from.
 * The pair rather than the bare group, because a bundle may claim one mode of a
 * group and leave the other to a sibling.
 */
function reachableGroupAccess(): { groupId: string; accessMode: string }[] {
  const seen = new Map<string, { groupId: string; accessMode: string }>();
  for (const op of getAllOperations().values()) {
    if (op.internal || op.agentTool === false) continue;
    seen.set(`${op.capabilityGroupId}:${op.accessMode}`, {
      groupId: op.capabilityGroupId,
      accessMode: op.accessMode,
    });
  }
  return [...seen.values()];
}

describe('capability bundles — coverage invariant', () => {
  // The control renders bundles, so an unassigned group is capability the
  // operator can never see or shed. Enumerating groups by hand is what rots;
  // this fails the moment a new operation introduces one.
  it('assigns every agent-reachable capability group to a bundle', () => {
    const unassigned = reachableGroupAccess()
      .filter((g) => bundleForCapabilityGroup(g.groupId, g.accessMode) === undefined)
      .map((g) => `${g.groupId}:${g.accessMode}`)
      .sort();
    expect(unassigned).toEqual([]);
  });

  it('assigns each capability group to exactly one bundle', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const bundle of CAPABILITY_BUNDLES) {
      for (const group of bundle.capabilityGroupIds) {
        const prior = seen.get(group);
        if (prior) collisions.push(`${group}: ${prior} + ${bundle.id}`);
        else seen.set(group, bundle.id);
      }
    }
    expect(collisions).toEqual([]);
  });

  it('names no capability group that does not exist', () => {
    const groups = new Set(reachableGroupAccess().map((g) => g.groupId));
    const pairs = new Set(reachableGroupAccess().map((g) => `${g.groupId}:${g.accessMode}`));
    const phantom = CAPABILITY_BUNDLES.flatMap((b) =>
      b.capabilityGroupIds
        .filter((g) => (g.includes(':') ? !pairs.has(g) : !groups.has(g)))
        .map((g) => `${b.id} -> ${g}`),
    );
    expect(phantom).toEqual([]);
  });

  it('resolves a split group to the bundle owning that access mode', () => {
    // memory.store holds both reads and writes, and they are different
    // decisions — the mode-qualified claim has to beat a whole-group one.
    expect(bundleForOperation('memory.store.query')?.id).toBe('memory_read');
    expect(bundleForOperation('memory.store.put')?.id).toBe('memory_write');
    expect(bundleForOperation('memory.context.list')?.id).toBe('memory_read');
    expect(bundleForOperation('memory.context.remember')?.id).toBe('memory_write');
  });

  it('gives every bundle a unique id, a label, and a hint', () => {
    const ids = CAPABILITY_BUNDLES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of CAPABILITY_BUNDLES) {
      expect(b.label.length).toBeGreaterThan(0);
      expect(b.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('capability bundles — resolution', () => {
  it('resolves an operation to its bundle through the capability group', () => {
    expect(bundleForOperation('memory.store.query')?.id).toBe('memory_read');
    expect(bundleForOperation('workflow.run.start')?.id).toBe('run_skills');
    expect(bundleForOperation('ai.media.video')?.id).toBe('media');
    expect(bundleForOperation('api.definition.delete')?.id).toBe('integrations');
  });

  it('returns undefined for an unknown operation rather than throwing', () => {
    expect(bundleForOperation('nope.not.real')).toBeUndefined();
  });

  it('expands bundle ids to their capability groups', () => {
    expect(capabilityGroupsForBundles(['memory_read', 'web'])).toEqual(
      new Set(['memory.store:read', 'memory.context:read', 'memory.run_output', 'search.web']),
    );
  });

  it('ignores an unknown bundle id instead of failing the turn', () => {
    // A directive naming a renamed bundle must degrade to "not disabled".
    expect(capabilityGroupsForBundles(['memory_read', 'retired_bundle'])).toEqual(
      new Set(['memory.store:read', 'memory.context:read', 'memory.run_output']),
    );
  });
});

describe('capability bundles — locked bundles', () => {
  it('locks chat and capability discovery, with a reason', () => {
    for (const id of ['chat', 'discovery']) {
      const bundle = getCapabilityBundle(id);
      expect(bundle?.locked?.reason).toBeTruthy();
    }
  });

  it('refuses to shed a locked bundle even when a directive names it', () => {
    expect(shedableBundleIds(['memory_read', 'chat', 'discovery', 'web'])).toEqual([
      'memory_read',
      'web',
    ]);
  });

  it('drops unknown ids from the shedable set', () => {
    expect(shedableBundleIds(['memory_read', 'retired_bundle'])).toEqual(['memory_read']);
  });
});

describe('capability bundles — what a surface offers', () => {
  it('offers only bundles the surface actually reaches', () => {
    const offered = bundlesForSurface(['memory.store.query', 'search.web.search']).map((b) => b.id);
    expect(offered).toEqual(['memory_read', 'web']);
  });

  it('preserves registry order regardless of the order ops arrive in', () => {
    const offered = bundlesForSurface(['search.web.search', 'human.chat.ask', 'memory.store.get']);
    expect(offered.map((b) => b.id)).toEqual(['chat', 'memory_read', 'web']);
  });

  it('deduplicates when several ops share a bundle', () => {
    const offered = bundlesForSurface(['memory.store.query', 'memory.store.get']);
    expect(offered.map((b) => b.id)).toEqual(['memory_read']);
  });

  it('ignores operations that do not resolve', () => {
    expect(bundlesForSurface(['nope.not.real']).map((b) => b.id)).toEqual([]);
  });
});

describe('capability bundles — placement defaults and locks', () => {
  it('derives the default placement from the authored tier', () => {
    expect(defaultPlacement(getCapabilityBundle('memory_read')!)).toBe('always_on');
    expect(defaultPlacement(getCapabilityBundle('applets')!)).toBe('on_demand');
  });

  it('lets a stored value override the default', () => {
    const applets = getCapabilityBundle('applets')!;
    expect(effectivePlacement(applets, { applets: 'always_on' })).toBe('always_on');
    expect(effectivePlacement(applets, undefined)).toBe('on_demand');
    // A value that is not a placement falls back rather than throwing.
    expect(effectivePlacement(applets, { applets: 'nonsense' })).toBe('on_demand');
  });

  it('refuses any placement on a locked bundle', () => {
    for (const id of ['chat', 'discovery']) {
      expect(effectivePlacement(getCapabilityBundle(id)!, { [id]: 'off' })).toBe('always_on');
    }
  });
});

describe('capability bundles — the pinned cap is enforced at write', () => {
  it('accepts a placement that fits', () => {
    const verdict = validateBundlePlacements(['memory.store.query'], ['ui.applet.get'], {
      applets: 'always_on',
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.pinnedCount).toBe(2);
  });

  it('refuses a placement that would exceed the cap, and says by how much', () => {
    // buildAvailableTools throws past the cap, so a stored value over it would
    // fail every turn in the space rather than degrading.
    const core = Array.from({ length: MAX_PINNED_TOOLS }, (_, i) => `memory.store.op${String(i)}`);
    const verdict = validateBundlePlacements([...core, 'memory.store.query'], [], undefined);
    expect(verdict.ok).toBe(false);
    expect(verdict.pinnedCount).toBeGreaterThan(MAX_PINNED_TOOLS);
    expect(verdict.message).toContain(String(MAX_PINNED_TOOLS));
  });
});
