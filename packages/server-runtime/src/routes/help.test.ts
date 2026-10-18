/**
 * The help routes return only the articles true in the process's edition —
 * in the list, in search, in one read, and among an article's related links.
 */
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { allHelpArticles } from '@aflow/platform-artifacts';
import type {
  EditionDescriptor,
  EditionId,
  HelpArticleListResponse,
  HelpArticleResponse,
} from '@aflow/schemas';
import { helpRoutes } from './help.js';

async function buildApp(edition: EditionId, authenticated = true): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('edition', { edition } as EditionDescriptor);
  app.decorate('authenticate', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!authenticated) await reply.code(401).send({ error: 'Unauthenticated' });
  });
  await app.register(helpRoutes, { prefix: '/v1/help' });
  await app.ready();
  return app;
}

const ARTICLES = allHelpArticles();
const LOCAL_ONLY = ARTICLES.find(
  (article) => article.editions.length === 1 && article.editions[0] === 'community-local',
);
const HOSTED_ONLY = ARTICLES.find(
  (article) => article.editions.length === 1 && article.editions[0] === 'enterprise',
);

describe('GET /v1/help/articles', () => {
  it('refuses an unauthenticated caller', async () => {
    const app = await buildApp('community-local', false);
    expect((await app.inject({ url: '/v1/help/articles' })).statusCode).toBe(401);
  });

  it('lists exactly the articles true in the edition', async () => {
    for (const edition of ['community-local', 'enterprise'] as const) {
      const app = await buildApp(edition);
      const body = (await app.inject({ url: '/v1/help/articles' })).json<HelpArticleListResponse>();
      expect(body.articles.map((article) => article.id).sort()).toEqual(
        ARTICLES.filter((article) => article.editions.includes(edition))
          .map((article) => article.id)
          .sort(),
      );
    }
  });

  it('never finds an article from the other edition by searching for it', async () => {
    expect(LOCAL_ONLY).toBeDefined();
    if (LOCAL_ONLY === undefined) return;
    const app = await buildApp('enterprise');
    const body = (
      await app.inject({
        url: `/v1/help/articles?q=${encodeURIComponent(LOCAL_ONLY.question)}`,
      })
    ).json<HelpArticleListResponse>();
    expect(body.articles.map((article) => article.id)).not.toContain(LOCAL_ONLY.id);
  });

  it('filters by theme', async () => {
    const app = await buildApp('community-local');
    const body = (
      await app.inject({ url: '/v1/help/articles?theme=skills' })
    ).json<HelpArticleListResponse>();
    expect(body.articles.length).toBeGreaterThan(0);
    expect(body.articles.every((article) => article.theme === 'skills')).toBe(true);
  });
});

describe('GET /v1/help/articles/:articleId', () => {
  it('reads an article true in the edition, with its related articles', async () => {
    const app = await buildApp('community-local');
    const response = await app.inject({ url: '/v1/help/articles/what-is-a-skill' });
    expect(response.statusCode).toBe(200);
    const body = response.json<HelpArticleResponse>();
    expect(body.article.id).toBe('what-is-a-skill');
    expect(body.related.map((article) => article.id)).toEqual(body.article.related);
  });

  it('answers 404 for an article that is not true in the edition', async () => {
    expect(HOSTED_ONLY).toBeDefined();
    if (HOSTED_ONLY === undefined) return;
    const app = await buildApp('community-local');
    expect((await app.inject({ url: `/v1/help/articles/${HOSTED_ONLY.id}` })).statusCode).toBe(404);
  });

  it('returns only related articles true in the edition', async () => {
    for (const edition of ['community-local', 'enterprise'] as const) {
      const app = await buildApp(edition);
      const inEdition = new Set(
        ARTICLES.filter((article) => article.editions.includes(edition)).map(
          (article) => article.id,
        ),
      );
      for (const id of inEdition) {
        const body = (
          await app.inject({ url: `/v1/help/articles/${id}` })
        ).json<HelpArticleResponse>();
        expect(body.related.filter((article) => !inEdition.has(article.id))).toEqual([]);
      }
    }
  });
});
