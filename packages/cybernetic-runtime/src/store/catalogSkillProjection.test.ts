/**
 * Contract: a workflow stands in for a catalog skill only when it is that
 * skill as the Store installed it; anything else is refused, saying why.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillCatalogEntry, StoreInstallDivergence, TenantId } from '@aflow/schemas';

vi.mock('@aflow/database', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
    cb({}),
  ),
}));

const mockComputeInstallDivergence = vi.fn();
vi.mock('./storeDivergence.js', () => ({
  computeInstallDivergence: (...args: unknown[]) => mockComputeInstallDivergence(...args),
}));

import { checkCatalogSkillProjection } from './catalogSkillProjection.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const REVIEW = {
  catalogId: 'review-local-changes',
  bundle: { workflow: { slug: 'review-local-changes' } },
} as unknown as SkillCatalogEntry;

function catalog(catalogId: string): SkillCatalogEntry | null {
  return catalogId === REVIEW.catalogId ? REVIEW : null;
}

function installed(artifacts: StoreInstallDivergence['artifacts']): StoreInstallDivergence {
  return { customized: artifacts.some((a) => a.state !== 'pristine'), artifacts };
}

const args = {
  tenantId: TENANT,
  spaceId: SPACE,
  catalogId: 'review-local-changes',
  slug: 'review-local-changes',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkCatalogSkillProjection', () => {
  it('accepts the skill exactly as the Store installed it', async () => {
    mockComputeInstallDivergence.mockResolvedValue(
      installed([
        { artifactType: 'skill', artifactKey: 'review-local-changes', state: 'pristine' },
      ]),
    );

    await expect(checkCatalogSkillProjection({} as never, args, catalog)).resolves.toEqual({
      ok: true,
    });
    expect(mockComputeInstallDivergence).toHaveBeenCalledWith(
      {},
      { tenantId: TENANT, spaceId: SPACE },
      'review-local-changes',
    );
  });

  it('refuses an edited copy, saying it is no longer that skill and how to restore it', async () => {
    mockComputeInstallDivergence.mockResolvedValue(
      installed([
        { artifactType: 'skill', artifactKey: 'review-local-changes', state: 'modified' },
      ]),
    );

    const check = await checkCatalogSkillProjection({} as never, args, catalog);

    expect(check).toEqual({
      ok: false,
      reason: 'modified',
      message:
        '"review-local-changes" in this space has been edited since the Store installed it from "review-local-changes", so it is no longer that skill. Update it from the Store, replacing the edits.',
    });
  });

  it('refuses a workflow that holds the slug but was never installed from the catalog', async () => {
    mockComputeInstallDivergence.mockResolvedValue(installed([]));

    const check = await checkCatalogSkillProjection({} as never, args, catalog);

    expect(check).toMatchObject({ ok: false, reason: 'not_installed' });
    expect(check.ok ? '' : check.message).toContain(
      'was not installed from the catalog skill "review-local-changes"',
    );
  });

  it('refuses a catalog id the registry does not know, and a slug the entry does not install as', async () => {
    expect(
      await checkCatalogSkillProjection({} as never, { ...args, catalogId: 'nope' }, catalog),
    ).toMatchObject({ ok: false, reason: 'not_in_catalog' });
    expect(
      await checkCatalogSkillProjection({} as never, { ...args, slug: 'my-review' }, catalog),
    ).toMatchObject({
      ok: false,
      reason: 'other_slug',
      message:
        'The catalog skill "review-local-changes" installs as "review-local-changes", not "my-review".',
    });
    expect(mockComputeInstallDivergence).not.toHaveBeenCalled();
  });
});
