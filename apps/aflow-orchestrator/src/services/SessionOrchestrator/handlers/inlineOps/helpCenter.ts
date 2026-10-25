import {
  HelpGetInputSchema,
  HelpSearchInputSchema,
  helpArticlePath,
  resolveEditionDescriptor,
  type HelpGetOutput,
  type HelpSearchOutput,
} from '@aflow/schemas';
import {
  getHelpArticle,
  listHelpArticles,
  searchHelpArticles,
  toHelpArticleSummary,
} from '@aflow/platform-artifacts';
import type { InlineHandlerArgs } from './types.js';
import { emitStepError, emitStepSuccess } from './helpers.js';
import { readInlineInput } from './readInlineInput.js';

export async function handleHelpSearch(args: InlineHandlerArgs): Promise<void> {
  const start = Date.now();
  const raw = await readInlineInput(args, start);
  if (!raw) return;
  const parsed = HelpSearchInputSchema.safeParse(raw);
  if (!parsed.success) {
    await emitStepError(args, 'INVALID_INPUT', parsed.error.message, start, 'validation');
    return;
  }
  const { query, theme, limit } = parsed.data;
  const { edition } = resolveEditionDescriptor();
  const articles = listHelpArticles({ edition, ...(theme !== undefined ? { theme } : {}) });
  const result: HelpSearchOutput = {
    articles: searchHelpArticles(articles, query, { maxResults: limit }).map(({ article }) =>
      toHelpArticleSummary(article),
    ),
  };
  await emitStepSuccess(args, result, start);
}

export async function handleHelpGet(args: InlineHandlerArgs): Promise<void> {
  const start = Date.now();
  const raw = await readInlineInput(args, start);
  if (!raw) return;
  const parsed = HelpGetInputSchema.safeParse(raw);
  if (!parsed.success) {
    await emitStepError(args, 'INVALID_INPUT', parsed.error.message, start, 'validation');
    return;
  }
  const { edition } = resolveEditionDescriptor();
  const article = getHelpArticle(parsed.data.articleId, edition);
  if (article === undefined) {
    await emitStepError(
      args,
      'HELP_ARTICLE_NOT_FOUND',
      `No help article "${parsed.data.articleId}" in this edition. Use an id that catalog.help.search returned.`,
      start,
      'validation',
    );
    return;
  }
  const result: HelpGetOutput = {
    article: {
      id: article.id,
      theme: article.theme,
      question: article.question,
      summary: article.summary,
      body: article.body,
    },
    related: article.related
      .map((id) => getHelpArticle(id, edition))
      .filter((related) => related !== undefined)
      .map(toHelpArticleSummary),
    pageUrl: helpArticlePath(article.id),
  };
  await emitStepSuccess(args, result, start);
}
