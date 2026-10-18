/**
 * Help articles (Plan 324): the platform's own answers, read from the
 * platform-artifact catalog and filtered to the articles true in this
 * process's edition. Needs no model provider — this is where an operator
 * without one finds out how to add one.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  HelpArticleIdSchema,
  HelpArticleListQuerySchema,
  HelpArticleListResponseSchema,
  HelpArticleResponseSchema,
} from '@aflow/schemas';
import {
  getHelpArticle,
  listHelpArticles,
  searchHelpArticles,
  toHelpArticleSummary,
} from '@aflow/platform-artifacts';

const HELP_AUTHZ_EXEMPTION = {
  reason:
    'Platform-owned help content, identical for every tenant and principal; authentication is the only gate.',
};

export const helpRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  const edition = fastify.edition.edition;

  app.get(
    '/articles',
    {
      config: { authzExempt: HELP_AUTHZ_EXEMPTION },
      schema: {
        tags: ['Help'],
        summary: 'List or search help articles true in this edition',
        querystring: HelpArticleListQuerySchema,
        response: { 200: HelpArticleListResponseSchema },
      },
    },
    async (request) => {
      const { q, theme } = request.query;
      const articles = listHelpArticles({ edition, ...(theme !== undefined ? { theme } : {}) });
      const selected =
        q === undefined ? articles : searchHelpArticles(articles, q).map(({ article }) => article);
      return { articles: selected.map(toHelpArticleSummary) };
    },
  );

  app.get(
    '/articles/:articleId',
    {
      config: { authzExempt: HELP_AUTHZ_EXEMPTION },
      schema: {
        tags: ['Help'],
        summary: 'Read one help article',
        params: z.object({ articleId: HelpArticleIdSchema }),
        response: {
          200: HelpArticleResponseSchema,
          404: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const article = getHelpArticle(request.params.articleId, edition);
      if (article === undefined) {
        return reply.status(404).send({
          error: 'HELP_ARTICLE_NOT_FOUND',
          message: `No help article '${request.params.articleId}' in this edition.`,
        });
      }
      const related = article.related
        .map((id) => getHelpArticle(id, edition))
        .filter((entry) => entry !== undefined)
        .map(toHelpArticleSummary);
      return { article, related };
    },
  );
};
