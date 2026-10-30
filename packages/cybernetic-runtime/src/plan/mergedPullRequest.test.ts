import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
const { execute, resolve, decrypt } = vi.hoisted(() => ({
  execute: vi.fn(),
  resolve: vi.fn(),
  decrypt: vi.fn(),
}));
vi.mock('../repoConnection.js', () => ({ resolveConnectionForRepoCoordinate: resolve }));
vi.mock('@aflow/database', () => ({
  createTenantContext: vi.fn(),
  decryptCredentialAsync: decrypt,
  withTenantSchema: (_db: unknown, _tenant: unknown, read: (tx: unknown) => unknown) =>
    read({ execute }),
}));
import { readMergedPullRequest } from './mergedPullRequest.js';

const URL = 'https://github.com/aflowai/aflow/pull/160';
const db = {} as PostgresJsDatabase;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('scheduled merge attestation', () => {
  it.each([
    [{ merged: true, html_url: URL }, true],
    [{ merged: false, html_url: URL }, false],
    [{ merged: true, html_url: URL + '1' }, false],
    [{ merged: 'true', html_url: URL }, false],
    [null, false],
  ])('uses GitHub response %j', async (answer, expected) => {
    resolve.mockResolvedValue('github-default');
    execute.mockResolvedValue([{ encrypted: 'sealed' }]);
    decrypt.mockResolvedValue('token');
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => answer });
    vi.stubGlobal('fetch', request);
    expect(await readMergedPullRequest(db, 'tenant', 'space', URL)).toBe(expected);
    expect(request).toHaveBeenCalledWith(
      'https://api.github.com/repos/aflowai/aflow/pulls/160',
      expect.objectContaining({ redirect: 'error', cache: 'no-store' }),
    );
    expect(resolve).toHaveBeenCalledWith(db, 'tenant', 'space', 'aflowai/aflow');
  });

  it('does not request arbitrary hosts or use stored merge answers', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    expect(
      await readMergedPullRequest(db, 'tenant', 'space', URL.replace('github.com', 'example.com')),
    ).toBe(false);
    expect(request).not.toHaveBeenCalled();
    resolve.mockResolvedValue('github-default');
    execute.mockResolvedValue([{ encrypted: 'sealed' }]);
    decrypt.mockResolvedValue('token');
    request.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ merged: true, html_url: URL }),
    });
    request.mockResolvedValueOnce({ ok: false });
    expect(await readMergedPullRequest(db, 'tenant', 'space', URL)).toBe(true);
    expect(await readMergedPullRequest(db, 'tenant', 'space', URL)).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
