import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HelpGetOutputSchema, HelpSearchOutputSchema, type EditionId } from '@aflow/schemas';
import { allHelpArticles } from '@aflow/platform-artifacts';
import type { InlineHandlerArgs } from './types.js';

const { success, error } = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('./helpers.js', () => ({ emitStepSuccess: success, emitStepError: error }));
const { handleHelpGet, handleHelpSearch } = await import('./helpCenter.js');

function args(input: unknown): InlineHandlerArgs {
  return {
    payloadStore: { retrieve: () => Promise.resolve(input) },
    resolvedInputRef: 'inline:input',
  } as unknown as InlineHandlerArgs;
}

function lastSuccess(): unknown {
  return success.mock.calls.at(-1)?.[1];
}

const localOnly = allHelpArticles().find(
  (article) => article.editions.length === 1 && article.editions[0] === 'community-local',
);
if (localOnly === undefined) throw new Error('the catalog has no local-only article to probe with');

function inEdition(edition: EditionId): void {
  vi.stubEnv('PHOENIX_EDITION', edition);
}

describe('catalog.help reads answer only for the edition the platform runs', () => {
  beforeEach(() => {
    success.mockClear();
    error.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('finds a local-only answer by its own question locally, and not in the hosted edition', async () => {
    inEdition('community-local');
    await handleHelpSearch(args({ query: localOnly.question }));
    const local = HelpSearchOutputSchema.parse(lastSuccess());
    expect(local.articles.map((article) => article.id)).toContain(localOnly.id);

    inEdition('enterprise');
    await handleHelpSearch(args({ query: localOnly.question }));
    const hosted = HelpSearchOutputSchema.parse(lastSuccess());
    expect(hosted.articles.map((article) => article.id)).not.toContain(localOnly.id);
  });

  it('returns no more matches than the limit asks for', async () => {
    inEdition('enterprise');
    await handleHelpSearch(args({ query: 'skill', limit: 2 }));
    expect(HelpSearchOutputSchema.parse(lastSuccess()).articles.length).toBeLessThanOrEqual(2);
  });

  it('refuses to read an answer outside the edition, naming the search as the source of ids', async () => {
    inEdition('enterprise');
    await handleHelpGet(args({ articleId: localOnly.id }));
    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      'HELP_ARTICLE_NOT_FOUND',
      expect.stringContaining('catalog.help.search'),
      expect.any(Number),
      'validation',
    );
  });

  it('reads an answer with its page link and only related answers true in the edition', async () => {
    for (const edition of ['enterprise', 'community-local'] as const) {
      inEdition(edition);
      for (const article of allHelpArticles().filter((entry) => entry.editions.includes(edition))) {
        await handleHelpGet(args({ articleId: article.id }));
        const output = HelpGetOutputSchema.parse(lastSuccess());
        expect(output.pageUrl).toBe(`/help/${article.id}`);
        for (const related of output.related) {
          const relatedArticle = allHelpArticles().find((entry) => entry.id === related.id);
          expect(relatedArticle?.editions).toContain(edition);
        }
      }
    }
  });

  it('rejects input the schema refuses rather than searching for nothing', async () => {
    await handleHelpSearch(args({ query: '' }));
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      'INVALID_INPUT',
      expect.any(String),
      expect.any(Number),
      'validation',
    );
  });
});
