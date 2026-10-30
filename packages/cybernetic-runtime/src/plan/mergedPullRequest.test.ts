import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
const { execute, resolve, task } = vi.hoisted(() => ({
  execute: vi.fn(),
  resolve: vi.fn(),
  task: vi.fn(),
}));
vi.mock('../repoConnection.js', () => ({ resolveConnectionForRepoCoordinate: resolve }));
vi.mock('../ledger/queries.js', () => ({ getTaskRow: task }));
vi.mock('@aflow/database', () => ({
  createTenantContext: vi.fn(),
  withTenantSchema: (_db: unknown, _tenant: unknown, read: (tx: unknown) => unknown) =>
    read({ execute }),
}));
import { readMergedPullRequest } from './mergedPullRequest.js';

const URL = 'https://github.com/aflowai/aflow/pull/160';
const SHA = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const db = {} as PostgresJsDatabase;
const retrieve = vi.fn();
const readBinding = vi.fn();
const deps = { payloadStore: { retrieve } as unknown as PayloadStore, readBinding };
const read = (url = URL) => readMergedPullRequest(db, 'tenant', 'space', url, 'node', deps);
beforeEach(() => {
  vi.resetAllMocks();
  resolve.mockResolvedValue('github-default');
  execute.mockResolvedValue([{ run_id: 'publication' }]);
  task.mockResolvedValue({
    status: 'succeeded',
    operationId: 'host.file.patch',
    outputRef: 'record',
  });
  retrieve.mockResolvedValue({ commit: { sha: SHA, branch: 'aflow/work' } });
  readBinding.mockResolvedValue({
    merged: true,
    html_url: URL,
    merge_commit_sha: MERGE,
    head: { sha: SHA, ref: 'aflow/work', repo: { full_name: 'aflowai/aflow' } },
  });
});

describe('scheduled merge attestation', () => {
  it('reads GitHub through the binding on every close against the node publication record', async () => {
    expect(await read()).toBe(true);
    expect(task).toHaveBeenCalledWith(db, 'tenant', 'publication', 'commit');
    expect(readBinding).toHaveBeenCalledWith('github-default', 'getPullRequest', {
      owner: 'aflowai',
      repo: 'aflow',
      pull_number: '160',
    });
    readBinding.mockResolvedValueOnce({ merged: false, html_url: URL });
    expect(await read()).toBe(false);
  });
  it('accepts canonical owner and repository case', async () => {
    expect(await read(URL.replace('aflowai/aflow', 'AflowAI/Aflow') + '/')).toBe(true);
  });
  it.each([null, { merged: 'true', html_url: URL }, { merged: true, html_url: URL + '1' }])(
    'refuses a mismatched GitHub answer %j',
    async (answer) => {
      readBinding.mockResolvedValue(answer);
      expect(await read()).toBe(false);
    },
  );
  it('rejects unrelated merged pull requests even with planted links', async () => {
    readBinding.mockResolvedValueOnce({
      merged: true,
      html_url: URL,
      merge_commit_sha: MERGE,
      head: { sha: 'c'.repeat(40), ref: 'unrelated', repo: { full_name: 'aflowai/aflow' } },
    });
    readBinding.mockResolvedValueOnce({ status: 'diverged' });
    expect(await read()).toBe(false);
  });
  it.each(['ahead', 'identical'])(
    'accepts a recorded commit reachable from the merge (%s)',
    async (status) => {
      readBinding.mockResolvedValueOnce({ merged: true, html_url: URL, merge_commit_sha: MERGE });
      readBinding.mockResolvedValueOnce({ status });
      expect(await read()).toBe(true);
      expect(readBinding).toHaveBeenLastCalledWith('github-default', 'compareCommits', {
        owner: 'aflowai',
        repo: 'aflow',
        base: SHA,
        head: MERGE,
      });
    },
  );
  it('accepts a matching branch after squash without trusting another repository', async () => {
    const answer = {
      merged: true,
      html_url: URL,
      merge_commit_sha: MERGE,
      head: { sha: 'c'.repeat(40), ref: 'aflow/work', repo: { full_name: 'aflowai/aflow' } },
    };
    readBinding.mockResolvedValueOnce(answer);
    expect(await read()).toBe(true);
    readBinding.mockResolvedValueOnce({
      ...answer,
      head: { ...answer.head, repo: { full_name: 'other/aflow' } },
    });
    readBinding.mockResolvedValueOnce({ status: 'diverged' });
    expect(await read()).toBe(false);
  });
  it('refuses absent publication records and arbitrary hosts without a binding call', async () => {
    expect(await read(URL.replace('github.com', 'example.com'))).toBe(false);
    execute.mockResolvedValueOnce([]);
    expect(await read()).toBe(false);
    expect(readBinding).not.toHaveBeenCalled();
  });
  it('refuses an agent task posing as a publication commit', async () => {
    task.mockResolvedValueOnce({
      status: 'succeeded',
      operationId: 'agent.turn',
      outputRef: 'forged',
    });
    expect(await read()).toBe(false);
    expect(readBinding).not.toHaveBeenCalled();
  });
});
