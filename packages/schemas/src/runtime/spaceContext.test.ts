import { describe, it, expect } from 'vitest';
import {
  buildSpaceContextNavigation,
  NAVIGATION_GUIDANCE,
  projectSpaceContextForModel,
  SpaceContextHostFoldersSectionSchema,
  SpaceContextNavigationSchema,
  SpaceContextRepositoriesSectionSchema,
  SpaceContextSchema,
  type SpaceContext,
} from './spaceContext.js';

describe('SpaceContext repositories section', () => {
  const section = {
    items: [
      {
        repo: 'munchist/duality',
        defaultBranch: 'main',
      },
    ],
    total: 1,
    guidance: 'Use the repo coordinate as the coding skill campaign config.',
  };

  it('validates a ready-repos section and accepts it on the space context', () => {
    expect(SpaceContextRepositoriesSectionSchema.parse(section)).toEqual(section);
    const ctx = {
      version: 1 as const,
      space: { id: '00000000-0000-0000-0000-000000000001', slug: 's', name: 'S' },
      repositories: section,
    };
    expect(SpaceContextSchema.parse(ctx).repositories?.items[0]?.repo).toBe('munchist/duality');
  });

  it('carries only the coordinate + default branch (status lives on the operator surface)', () => {
    const parsed = SpaceContextRepositoriesSectionSchema.parse(section);
    expect(Object.keys(parsed.items[0]!).sort()).toEqual(['defaultBranch', 'repo']);
  });
});

describe('SpaceContext host folders section', () => {
  const folder = {
    id: 'hb_app',
    label: 'app',
    root: '/tmp/app',
    access: 'read_write',
    canRunCommands: true,
    branchPrefix: 'aflow/',
    pushApproval: 'unless-unreviewed',
  };
  const parse = (checks: unknown) =>
    SpaceContextHostFoldersSectionSchema.safeParse({
      items: [{ ...folder, checks }],
      harnesses: [],
      total: 1,
      guidance: 'g',
    });

  it('carries that a folder declares checks and the program they run', () => {
    expect(parse({ program: 'node' }).success).toBe(true);
  });

  it('refuses checks carried as a command, so no argument can reach an agent', () => {
    expect(parse(['node', 'scripts/verify-commit.mjs', '--token=s3cr3t']).success).toBe(false);
  });
});

describe('buildSpaceContextNavigation', () => {
  it('builds the canonical route templates for a space', () => {
    const nav = buildSpaceContextNavigation('https://app.aflow.ai', 'general');
    expect(nav).toEqual({
      baseUrl: 'https://app.aflow.ai',
      spaceSlug: 'general',
      routes: {
        agent: 'https://app.aflow.ai/s/general/agents/{agentSlug}',
        skill: 'https://app.aflow.ai/s/general/skills/{skillSlug}',
        session: 'https://app.aflow.ai/s/general/sessions/{sessionId}',
        memory: 'https://app.aflow.ai/s/general/memory/{path}',
        integration: 'https://app.aflow.ai/s/general/integrations/{bindingId}',
        chat: 'https://app.aflow.ai/s/general/chat/{agentSlug}',
        applet: 'https://app.aflow.ai/s/general/applets/{instanceId}',
        store: 'https://app.aflow.ai/s/general/store',
        credentials: 'https://app.aflow.ai/settings/credentials',
        agentSettings: 'https://app.aflow.ai/s/general/settings/agent',
        computer: 'https://app.aflow.ai/s/general/computer',
        triggers: 'https://app.aflow.ai/s/general/triggers',
      },
      guidance: NAVIGATION_GUIDANCE,
    });
  });

  it('says the list is closed, so a missing page is not invented', () => {
    // Asked where to do something the app has no page for, an agent otherwise
    // answers from the shape of every other web app it has seen — a confident
    // path that 404s. One folder connected through a terminal produced exactly
    // that: an invented /integrations screen with steps nobody could follow.
    const nav = buildSpaceContextNavigation('https://app.aflow.ai', 'general');
    expect(nav.guidance).toMatch(/complete/i);
    // And it belongs to the route map rather than to any page's own prose, so
    // adding a route needs no words and a missing one cannot be talked around.
    expect(Object.keys(nav.routes)).toContain('computer');
  });

  it('strips trailing slashes from the base URL', () => {
    const nav = buildSpaceContextNavigation('https://app.aflow.ai/', 'general');
    expect(nav.baseUrl).toBe('https://app.aflow.ai');
    expect(nav.routes.agent.startsWith('https://app.aflow.ai/s/')).toBe(true);
  });

  it('URL-encodes slugs that need it', () => {
    const nav = buildSpaceContextNavigation('http://localhost:3001', 'with space');
    expect(nav.routes.chat).toBe('http://localhost:3001/s/with%20space/chat/{agentSlug}');
  });

  it('produces a value that round-trips through SpaceContextNavigationSchema', () => {
    const nav = buildSpaceContextNavigation('http://localhost:3001', 'general');
    expect(SpaceContextNavigationSchema.parse(nav)).toEqual(nav);
  });
});

describe('SpaceContextSchema with navigation', () => {
  it('accepts a space context with an optional navigation block', () => {
    const ctx = {
      version: 1 as const,
      space: { id: '00000000-0000-0000-0000-000000000001', slug: 'general', name: 'General' },
      navigation: buildSpaceContextNavigation('https://app.aflow.ai', 'general'),
    };
    expect(SpaceContextSchema.parse(ctx)).toEqual(ctx);
  });

  it('accepts a space context without navigation', () => {
    const ctx = {
      version: 1 as const,
      space: { id: '00000000-0000-0000-0000-000000000001', slug: 'general', name: 'General' },
    };
    const parsed = SpaceContextSchema.parse(ctx);
    expect(parsed.navigation).toBeUndefined();
  });

  it('rejects a space context that omits the slug', () => {
    const ctx = {
      version: 1 as const,
      space: { id: '00000000-0000-0000-0000-000000000001', name: 'General' },
    };
    expect(() => SpaceContextSchema.parse(ctx)).toThrow();
  });
});

describe('projectSpaceContextForModel — Plan 292 §4.1/§4.2b', () => {
  const directives = {
    version: 1,
    responsibility: 'Run the trading desk.',
    priorities: ['Capital preservation first'],
    style: 'Terse.',
    resourceBudget: { maxRunsPerDay: 20 },
    modelDefaults: { default: 'glm-pro' },
    reasoningDefaults: { helmsman: 'high' },
    learningPolicy: { minRunsBeforeProposal: 3 },
    capabilityDiscovery: { helmsmanOperations: ['memory.store.get', 'workflow.run.start'] },
  };

  const context = (): SpaceContext => ({
    version: 1,
    space: {
      id: '00000000-0000-0000-0000-000000000001',
      slug: 'desk',
      name: 'Desk',
      rules: [{ text: 'Never trade on rumour.' }],
      directives,
    },
  });

  const projectedDirectives = (role: Parameters<typeof projectSpaceContextForModel>[1]) =>
    projectSpaceContextForModel(context(), role).space.directives as
      Record<string, unknown> | undefined;

  it('drops directives entirely for the Helmsman — its prompt already carries the triple', () => {
    expect(projectedDirectives('helmsman')).toBeUndefined();
  });

  for (const role of ['runner', 'coach', 'other'] as const) {
    it(`keeps only the governance triple for ${role}`, () => {
      expect(projectedDirectives(role)).toEqual({
        responsibility: 'Run the trading desk.',
        priorities: ['Capital preservation first'],
        style: 'Terse.',
      });
    });
  }

  it('never ships orchestrator configuration to any role', () => {
    for (const role of ['helmsman', 'runner', 'coach', 'other'] as const) {
      const serialized = JSON.stringify(projectSpaceContextForModel(context(), role));
      // The Coach learning policy, run budget, model/reasoning selection and
      // the discovery allowlist steer the orchestrator and have no model
      // consumer — none of them may appear on the wire for anyone.
      expect(serialized).not.toContain('learningPolicy');
      expect(serialized).not.toContain('resourceBudget');
      expect(serialized).not.toContain('modelDefaults');
      expect(serialized).not.toContain('reasoningDefaults');
      expect(serialized).not.toContain('capabilityDiscovery');
      expect(serialized).not.toContain('helmsmanOperations');
    }
  });

  it("leaves the caller's object untouched — the cached copy still carries transport", () => {
    const original = context();
    projectSpaceContextForModel(original, 'helmsman');
    expect((original.space.directives as Record<string, unknown>)['modelDefaults']).toEqual({
      default: 'glm-pro',
    });
  });

  it('preserves every non-directive section', () => {
    const projected = projectSpaceContextForModel(context(), 'helmsman');
    expect(projected.space.rules).toEqual([{ text: 'Never trade on rumour.' }]);
    expect(projected.space.slug).toBe('desk');
    expect(projected.version).toBe(1);
  });

  it('is a no-op on a space with no directives', () => {
    const bare: SpaceContext = {
      version: 1,
      space: { id: '00000000-0000-0000-0000-000000000002', slug: 'plain', name: 'Plain' },
    };
    expect(projectSpaceContextForModel(bare, 'runner')).toEqual(bare);
  });

  it('drops the key when a space carries only orchestrator configuration', () => {
    const configOnly: SpaceContext = {
      version: 1,
      space: {
        id: '00000000-0000-0000-0000-000000000003',
        slug: 'cfg',
        name: 'Cfg',
        directives: { version: 1, modelDefaults: { default: 'glm-pro' } },
      },
    };
    expect(projectSpaceContextForModel(configOnly, 'runner').space.directives).toBeUndefined();
  });
});
