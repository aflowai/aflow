import { describe, expect, it, vi } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
const { query, resolve, directives } = vi.hoisted(() => ({
  query: vi.fn(),
  resolve: vi.fn(() => Promise.resolve<unknown>(null)),
  directives: { skillPlacements: { 'off-skill': 'off', pinned: 'always_on' } },
}));
vi.mock('@aflow/database', async (original) => ({
  ...(await original<typeof import('@aflow/database')>()),
  querySkillDiscovery: query,
  resolveWorkflowForStart: resolve,
  withTenantSchema: async () => [{ directives: { capabilityDiscovery: directives } }],
}));
vi.mock('./skill.js', async (original) => ({
  ...(await original<typeof import('./skill.js')>()),
  loadSkill: () => Promise.resolve(null),
}));
const { searchInstalledSkills, buildInstalledSkillAwareness } = await import('./skillDiscovery.js');
const ctx = {
  db: {} as PostgresJsDatabase,
  tenantId: 'a0000000-0000-0000-0000-000000000001',
  spaceId: 'space',
};
const NO_USAGE = { whenToUse: [], whenNotToUse: [], next: [], pitfalls: [] };
const USAGE = {
  whenToUse: ['Fixing a bug in the repository'],
  whenNotToUse: ['Publishing the patch — that is Publish Local Changes'],
  next: [{ skill: 'publish-local-changes', when: 'Once the patch is back' }],
  pitfalls: ['Start it with wait: none', 'Never pass the patch text'],
};
const entry = (slug: string, description = 'Review changes', usage = NO_USAGE) => ({
  slug,
  name: slug,
  description,
  usage,
  mode: 'process' as const,
  status: 'approved',
  origin: 'space' as const,
  revision: 1,
});
describe('bounded skill discovery', () => {
  it('returns when to use a skill, when not and what follows it, and counts its pitfalls', async () => {
    query.mockResolvedValue({
      skills: [entry('commission-change', 'Make a change', USAGE)],
      total: 1,
    });
    const result = await searchInstalledSkills(ctx, { query: 'fix a bug in the repo', limit: 5 });
    expect(result.skills[0]?.usage).toEqual({
      whenToUse: USAGE.whenToUse,
      whenNotToUse: USAGE.whenNotToUse,
      next: USAGE.next,
      pitfallCount: 2,
    });
    expect(JSON.stringify(result)).not.toContain('Never pass the patch text');
    expect(result.guidance).toContain('whenToUse');
  });
  it('keeps a skill’s whenToUse when its first result has to shed its description', async () => {
    query.mockResolvedValue({
      skills: [entry('pinned', 'x'.repeat(10000), { ...USAGE, whenNotToUse: ['y'.repeat(9000)] })],
      total: 1,
    });
    const result = await searchInstalledSkills(ctx, { query: 'review', limit: 5 }, true);
    expect(result.skills[0]?.descriptionOmitted).toBe(true);
    expect(result.skills[0]?.usage).toEqual({ whenToUse: USAGE.whenToUse });
  });
  it('carries a pinned skill’s usage summary into the space context', async () => {
    query.mockImplementation((_db, _tenant, _space, options: { onlySlugs?: string[] }) =>
      Promise.resolve(
        options.onlySlugs
          ? { skills: [entry('pinned', 'Make a change', USAGE)], total: 1 }
          : { skills: [], total: 3 },
      ),
    );
    const context = await buildInstalledSkillAwareness(ctx, directives.skillPlacements);
    expect(context.pinned[0]?.usage?.whenToUse).toEqual(USAGE.whenToUse);
    expect(context.pinned[0]?.usage?.next?.[0]?.skill).toBe('publish-local-changes');
    expect(context.pinned[0]?.usage?.pitfallCount).toBe(2);
  });
  it('reports a malformed workflow as unavailable without losing the search page', async () => {
    query.mockResolvedValue({ skills: [entry('broken'), entry('healthy')], total: 2 });
    resolve.mockResolvedValueOnce({ status: 'approved' });
    const result = await searchInstalledSkills(ctx, { query: 'review', limit: 5 });
    expect(result.skills.map((skill) => skill.slug)).toEqual(['broken', 'healthy']);
    expect(result.skills[0]?.readiness).toMatchObject({ canRun: false, contractValid: false });
  });
  it('filters off before search and keeps overflow reachable through a query-bound cursor', async () => {
    query.mockResolvedValue({ skills: [entry('skill-1001')], total: 1005 });
    const first = await searchInstalledSkills(ctx, { query: 'review', limit: 5 });
    expect(query.mock.calls.at(-1)?.[3]).toMatchObject({ excludedSlugs: ['off-skill'], offset: 0 });
    expect(first.total).toBe(1005);
    expect(first.skills[0]?.suggestedInspectCall.input).toEqual({
      slug: 'skill-1001',
      view: 'invocation',
    });
    expect(first.nextCursor).toBeDefined();
    await searchInstalledSkills(ctx, { query: 'review', limit: 5, cursor: first.nextCursor! });
    expect(query.mock.calls.at(-1)?.[3]).toMatchObject({ offset: 1 });
    await expect(
      searchInstalledSkills(ctx, { query: 'different', limit: 5, cursor: first.nextCursor! }),
    ).rejects.toThrow('cursor');
  });
  it('bounds the first result too, preserving its invocation reference when a description is too large', async () => {
    query.mockResolvedValue({ skills: [entry('pinned', 'x'.repeat(10000))], total: 1 });
    const result = await searchInstalledSkills(ctx, { query: 'review', limit: 5 }, true);
    expect(result.skills[0]?.descriptionOmitted).toBe(true);
    expect(result.skills[0]?.suggestedInspectCall.input.slug).toBe('pinned');
    expect(JSON.stringify(result).length).toBeLessThan(6300);
  });
  it('loads only pinned summaries even when the installed catalog has thousands of entries', async () => {
    query.mockImplementation((_db, _tenant, _space, options: { onlySlugs?: string[] }) =>
      Promise.resolve(
        options.onlySlugs ? { skills: [entry('pinned')], total: 1 } : { skills: [], total: 1005 },
      ),
    );
    const context = await buildInstalledSkillAwareness(ctx, directives.skillPlacements);
    expect(context.total).toBe(1005);
    expect(context.onDemandCount).toBe(1004);
    expect(context.pinned.map((s) => s.slug)).toEqual(['pinned']);
    expect(JSON.stringify(context).length).toBeLessThan(1500);
    expect(context.pinned[0]).not.toHaveProperty('firstTaskInputContract');
  });
  it('reports a post-revision pinned overflow without losing the space context', async () => {
    query.mockImplementation((_db, _tenant, _space, options: { onlySlugs?: string[] }) =>
      Promise.resolve(
        options.onlySlugs
          ? { skills: [entry('pinned', 'x'.repeat(10000))], total: 1 }
          : { skills: [], total: 1005 },
      ),
    );
    const context = await buildInstalledSkillAwareness(ctx, directives.skillPlacements);
    expect(context.omittedPinnedCount).toBe(1);
    expect(context.truncated).toBe(true);
    expect(context.guidance).toContain('search');
  });
});
