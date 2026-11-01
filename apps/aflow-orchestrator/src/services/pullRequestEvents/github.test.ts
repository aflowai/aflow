/**
 * The source's reads are conditional (Plan 339 D2): the ETag of an answer
 * goes back as If-None-Match, and a 304 hands back no body to parse.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createGitHubConditionalGet, GitHubReadError } from './github.js';

function answer(status: number, body: unknown, etag?: string): Response {
  return new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: etag !== undefined ? { etag } : {},
  });
}

const db = {} as PostgresJsDatabase;

describe('createGitHubConditionalGet', () => {
  it('sends the ETag it is given as If-None-Match, with the binding token, to api.github.com', async () => {
    const fetchImpl = vi.fn(async () => answer(304, null, '"p1"'));
    const get = createGitHubConditionalGet({
      db,
      fetchImpl,
      readToken: async () => 'token-339',
    });

    const result = await get({
      tenantId: 't',
      spaceId: 's',
      path: '/repos/o/r/pulls/1',
      etag: '"p1"',
    });

    expect(result).toEqual({ status: 304, etag: '"p1"', body: null });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/o/r/pulls/1');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer token-339',
      'If-None-Match': '"p1"',
    });
  });

  it('sends no If-None-Match on a first read, and hands back the answer and its ETag', async () => {
    const fetchImpl = vi.fn(async () => answer(200, { number: 1 }, '"p1"'));
    const get = createGitHubConditionalGet({ db, fetchImpl, readToken: async () => 'token' });

    const result = await get({ tenantId: 't', spaceId: 's', path: '/repos/o/r/pulls/1' });

    expect(result).toEqual({ status: 200, etag: '"p1"', body: { number: 1 } });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('If-None-Match');
  });

  it('reads the token once per space within its cache', async () => {
    const readToken = vi.fn(async () => 'token');
    const get = createGitHubConditionalGet({
      db,
      fetchImpl: async () => answer(304, null, '"p1"'),
      readToken,
      now: () => 0,
    });

    await get({ tenantId: 't', spaceId: 's', path: '/a', etag: '"p1"' });
    await get({ tenantId: 't', spaceId: 's', path: '/b', etag: '"p1"' });

    expect(readToken).toHaveBeenCalledTimes(1);
  });

  it('refuses an answer that is neither fresh nor unchanged', async () => {
    const get = createGitHubConditionalGet({
      db,
      fetchImpl: async () => answer(404, { message: 'Not Found' }),
      readToken: async () => 'token',
    });

    await expect(get({ tenantId: 't', spaceId: 's', path: '/a' })).rejects.toBeInstanceOf(
      GitHubReadError,
    );
  });
});
