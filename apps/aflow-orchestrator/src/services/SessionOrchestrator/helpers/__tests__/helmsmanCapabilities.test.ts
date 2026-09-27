import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import type { CatalogConfig, SpaceContext } from '@aflow/schemas';
import type { HelmsmanCapabilities } from '@aflow/cybernetic-runtime';
import { resolveHelmsmanCapabilities } from '../helmsmanCapabilities.js';

// The local edition refuses to resolve while identity-plane configuration it
// composes no reader for is present, so those keys are cleared alongside.
const EDITION_KEYS = [
  'PHOENIX_EDITION',
  'PHOENIX_HOST_REDIS_PASSWORD',
  'AUTH0_DOMAIN',
  'AUTH0_AUDIENCE',
  'AUTH0_CLIENT_ID',
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  for (const key of EDITION_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * The descriptor resolves once per process, so a case needing a different
 * edition re-imports the resolver against a fresh module graph.
 */
async function capabilitiesUnder(env: Record<string, string>): Promise<HelmsmanCapabilities> {
  for (const key of EDITION_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  vi.resetModules();
  const { resolveHelmsmanCapabilities: resolve } = await import('../helmsmanCapabilities.js');
  const capabilities = resolve(space(), catalog());
  for (const key of EDITION_KEYS) delete process.env[key];
  vi.resetModules();
  return capabilities;
}

/**
 * A false gate here silently removes load-bearing prompt doctrine, and the
 * assembler's own tests pass `capabilities` explicitly — so without this the
 * resolver's real inputs (space context + catalog config) were never exercised.
 */
const space = (over: Partial<SpaceContext> = {}): SpaceContext =>
  ({
    version: 1,
    space: { id: '00000000-0000-0000-0000-000000000001', slug: 's', name: 'S' },
    ...over,
  }) as SpaceContext;

const integrations = (statuses: Array<'bound' | 'needs_credentials' | 'disabled'>) =>
  space({
    integrations: {
      items: statuses.map((status, i) => ({
        sourceKind: 'api' as const,
        integrationId: `i${String(i)}`,
        name: `svc${String(i)}`,
        status,
        toolCount: 1,
      })),
      total: statuses.length,
      definitionOnlyCount: 0,
      guidance: '',
    },
  } as Partial<SpaceContext>);

const catalog = (core: string[] = [], discoverable: string[] = []): CatalogConfig =>
  ({
    coreOperations: core,
    ...(discoverable.length > 0 ? { discovery: { allowedOperationIds: discoverable } } : {}),
  }) as CatalogConfig;

describe('resolveHelmsmanCapabilities', () => {
  describe('canRenderInline — reachability, not the live pinned set', () => {
    it('is true when a ui op is pinned', () => {
      expect(
        resolveHelmsmanCapabilities(space(), catalog(['ui.surface.visualize'])).canRenderInline,
      ).toBe(true);
    });

    it('is true when a ui op is only PROMOTABLE', () => {
      // The doctrine is what teaches the agent to go and promote it. Gating on
      // "pinned right now" would withhold the instruction exactly when needed.
      expect(
        resolveHelmsmanCapabilities(space(), catalog([], ['ui.artifact.render'])).canRenderInline,
      ).toBe(true);
    });

    it('is false only when no ui op is reachable at all', () => {
      expect(
        resolveHelmsmanCapabilities(space(), catalog(['memory.store.get'])).canRenderInline,
      ).toBe(false);
    });
  });

  describe('hasIntegrations — only a BOUND service makes the promote flow actionable', () => {
    it('is true for a bound integration', () => {
      expect(resolveHelmsmanCapabilities(integrations(['bound']), catalog()).hasIntegrations).toBe(
        true,
      );
    });

    it('is false when every integration is unusable', () => {
      // `integrations.total` counts these, which is why the count is the wrong
      // signal — the doctrine would ship for a space that can call nothing.
      expect(
        resolveHelmsmanCapabilities(integrations(['needs_credentials', 'disabled']), catalog())
          .hasIntegrations,
      ).toBe(false);
    });

    it('is true when one of several is bound', () => {
      expect(
        resolveHelmsmanCapabilities(integrations(['disabled', 'bound']), catalog()).hasIntegrations,
      ).toBe(true);
    });

    it('is false with no integrations section at all', () => {
      expect(resolveHelmsmanCapabilities(space(), catalog()).hasIntegrations).toBe(false);
    });
  });

  describe('canLinkToRoutes', () => {
    it('is false when navigation is absent — links would resolve to nothing', () => {
      expect(resolveHelmsmanCapabilities(space(), catalog()).canLinkToRoutes).toBe(false);
    });

    it('is true when navigation is populated', () => {
      const ctx = space({
        navigation: { baseUrl: 'https://x', spaceSlug: 's', routes: {} },
      } as Partial<SpaceContext>);
      expect(resolveHelmsmanCapabilities(ctx, catalog()).canLinkToRoutes).toBe(true);
    });
  });

  describe('the direct actions — each one its own flag, so the section names only what is reachable', () => {
    const DIRECT = ['host.file.patch', 'host.file.put', 'host.process.exec'];

    it('is all three when the space reaches all three', () => {
      const can = resolveHelmsmanCapabilities(space(), catalog(DIRECT));
      expect([can.canApplyDiff, can.canWriteFiles, can.canRunCommands]).toEqual([true, true, true]);
    });

    it('is true for a promotable one, like every other reachability flag', () => {
      expect(
        resolveHelmsmanCapabilities(space(), catalog([], ['host.file.patch'])).canApplyDiff,
      ).toBe(true);
    });

    it('drops only the one the discovery ceiling removed', () => {
      // A ceiling that keeps the harness but removes the patch operation is the
      // case the conditional section exists for.
      const can = resolveHelmsmanCapabilities(
        space(),
        catalog(['host.harness.run', 'host.file.put', 'host.process.exec']),
      );
      expect(can.canApplyDiff).toBe(false);
      expect([can.canWriteFiles, can.canRunCommands]).toEqual([true, true]);
    });

    it('is all false where only the read operations survive', () => {
      const can = resolveHelmsmanCapabilities(
        space(),
        catalog(['host.file.get', 'host.harness.run']),
      );
      expect([can.canApplyDiff, can.canWriteFiles, can.canRunCommands]).toEqual([
        false,
        false,
        false,
      ]);
    });
  });

  it('withholds nothing for a fully-equipped space', () => {
    const ctx = integrations(['bound']);
    ctx.navigation = { baseUrl: 'https://x', spaceSlug: 's', routes: {} } as never;
    expect(
      resolveHelmsmanCapabilities(
        ctx,
        catalog(['ui.surface.visualize', 'host.file.patch', 'host.file.put', 'host.process.exec']),
      ),
    ).toEqual({
      canRenderInline: true,
      hasIntegrations: true,
      canLinkToRoutes: true,
      canCommissionHarness: false,
      canApplyDiff: true,
      canWriteFiles: true,
      canRunCommands: true,
    });
  });

  it('withholds everything only for a space that can do none of it', () => {
    expect(resolveHelmsmanCapabilities(undefined, undefined)).toEqual({
      canRenderInline: false,
      hasIntegrations: false,
      canLinkToRoutes: false,
      canCommissionHarness: false,
      canApplyDiff: false,
      canWriteFiles: false,
      canRunCommands: false,
    });
  });

  describe('canCommissionHarness — the edition, not the space', () => {
    it('is false under a hosted descriptor, whatever the space holds', async () => {
      const capabilities = await capabilitiesUnder({ PHOENIX_HOST_REDIS_PASSWORD: 'pw' });
      expect(capabilities.canCommissionHarness).toBe(false);
    });

    it('is true on the local edition composing a host lane', async () => {
      const capabilities = await capabilitiesUnder({
        PHOENIX_EDITION: 'community-local',
        PHOENIX_HOST_REDIS_PASSWORD: 'pw',
      });
      expect(capabilities.canCommissionHarness).toBe(true);
    });

    it('is false on the local edition while no machine can pair', async () => {
      const capabilities = await capabilitiesUnder({ PHOENIX_EDITION: 'community-local' });
      expect(capabilities.canCommissionHarness).toBe(false);
    });
  });
});
