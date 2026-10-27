import { describe, expect, it } from 'vitest';
import { CatalogEntryKindSchema, CatalogEntrySchema } from './catalogEntry.js';
import { StoreInstallKindSchema } from './provenance.js';
import { SpaceTemplateReadinessItemSchema, SpaceTemplateSchema } from './spaceTemplate.js';
import { StoreListingSearchInputSchema } from '../operations/store.js';

function validTemplate() {
  return {
    templateId: 'a-quick-start',
    version: 2,
    spaceName: 'Code Review',
    bundleIds: ['local-code-review'],
    directives: { responsibility: 'Review committed changes.', priorities: ['Cite evidence.'] },
    readiness: [
      {
        key: 'pair-machine',
        title: 'Pair this computer',
        required: true,
        answeredBy: 'pair_machine',
        page: '/computer',
      },
    ],
  };
}

function validSpaceEntry() {
  return {
    catalogId: 'a-quick-start',
    kind: 'space' as const,
    version: 2,
    name: 'Code Review',
    tagline: 'A new space that reviews.',
    description: 'Creates a space.',
    honestyLabel: 'curated' as const,
    payload: validTemplate(),
  };
}

describe('the space listing kind', () => {
  it('is a listing kind, an install kind and a search filter', () => {
    expect(CatalogEntryKindSchema.parse('space')).toBe('space');
    expect(StoreInstallKindSchema.parse('space')).toBe('space');
    expect(
      StoreListingSearchInputSchema.safeParse({ query: 'review', kind: 'space' }).success,
    ).toBe(true);
  });

  it('parses a space entry and defaults what the template does not write', () => {
    const entry = CatalogEntrySchema.parse(validSpaceEntry());
    if (entry.kind !== 'space') throw new Error('expected a space entry');
    expect(entry.payload.agents).toEqual([]);
    expect(entry.payload.apiDefinitions).toEqual([]);
    expect(entry.payload.help).toEqual([]);
  });

  it('rejects a template whose id or version differs from the envelope', () => {
    const renamed = validSpaceEntry();
    renamed.payload.templateId = 'another';
    expect(CatalogEntrySchema.safeParse(renamed).success).toBe(false);
    const bumped = validSpaceEntry();
    bumped.payload.version = 3;
    expect(CatalogEntrySchema.safeParse(bumped).success).toBe(false);
  });
});

describe('SpaceTemplateSchema', () => {
  it('needs at least one bundle, and names each once', () => {
    expect(SpaceTemplateSchema.safeParse({ ...validTemplate(), bundleIds: [] }).success).toBe(
      false,
    );
    expect(
      SpaceTemplateSchema.safeParse({ ...validTemplate(), bundleIds: ['a-bundle', 'a-bundle'] })
        .success,
    ).toBe(false);
  });

  it('writes only the directives a space owns as text', () => {
    expect(
      SpaceTemplateSchema.safeParse({
        ...validTemplate(),
        directives: { responsibility: 'x', modelDefaults: { default: 'sonnet' } },
      }).success,
    ).toBe(false);
  });

  it('rejects repeated readiness keys', () => {
    const [item] = validTemplate().readiness;
    expect(
      SpaceTemplateSchema.safeParse({ ...validTemplate(), readiness: [item, item] }).success,
    ).toBe(false);
  });
});

describe('SpaceTemplateReadinessItemSchema', () => {
  const item = validTemplate().readiness[0];

  it('is answered by a post-install task kind', () => {
    expect(SpaceTemplateReadinessItemSchema.safeParse(item).success).toBe(true);
    expect(
      SpaceTemplateReadinessItemSchema.safeParse({ ...item, answeredBy: 'feel_ready' }).success,
    ).toBe(false);
  });

  it('names the page or the command that changes it', () => {
    const { page: _page, ...withoutPage } = item ?? { page: '' };
    expect(SpaceTemplateReadinessItemSchema.safeParse(withoutPage).success).toBe(false);
    expect(
      SpaceTemplateReadinessItemSchema.safeParse({
        ...withoutPage,
        command: 'aflow harness merge-posture <folder> when-green',
      }).success,
    ).toBe(true);
  });

  it('carries no state of its own: state is read, never authored', () => {
    expect(SpaceTemplateReadinessItemSchema.safeParse({ ...item, state: 'done' }).success).toBe(
      false,
    );
  });
});
