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
  task.mockImplementation(async (_db, _tenant, _run, taskId) => ({
    status: 'succeeded',
    operationId: taskId === 'commit' ? 'host.file.patch' : 'api.http.call',
    outputRef: taskId === 'commit' ? 'record' : 'pr-record',
  }));
  retrieve.mockImplementation(async (ref) =>
    ref === 'pr-record' ? { prUrl: URL } : { commit: { sha: SHA, branch: 'aflow/work' } },
  );
  readBinding.mockResolvedValue({
    merged: true,
    merged_by: { login: 'operator' },
    merged_at: '2026-11-01T10:00:00Z',
    html_url: URL,
    merge_commit_sha: MERGE,
    head: { sha: SHA, ref: 'aflow/work', repo: { full_name: 'aflowai/aflow' } },
  });
});

describe('scheduled merge attestation', () => {
  it('reads GitHub through the binding on every close against the node publication record', async () => {
    expect(await read()).toMatchObject({ merged: true });
    expect(task).toHaveBeenCalledWith(db, 'tenant', 'publication', 'commit');
    expect(readBinding).toHaveBeenCalledWith('github-default', 'getPullRequest', {
      owner: 'aflowai',
      repo: 'aflow',
      pull_number: '160',
    });
    readBinding.mockResolvedValueOnce({ merged: false, html_url: URL });
    expect(await read()).toMatchObject({ merged: false });
  });
  it('accepts canonical owner and repository case', async () => {
    expect(await read(URL.replace('aflowai/aflow', 'AflowAI/Aflow') + '/')).toMatchObject({
      merged: true,
    });
  });
  it.each([{ merged: true, html_url: URL + '1' }])(
    'refuses a mismatched GitHub answer %j',
    async (answer) => {
      readBinding.mockResolvedValue(answer);
      expect(await read()).toMatchObject({ merged: false });
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
    expect(await read()).toMatchObject({ merged: false });
  });
  it.each(['ahead', 'identical'])(
    'accepts a recorded commit reachable from the merge (%s)',
    async (status) => {
      readBinding.mockResolvedValueOnce({ merged: true, html_url: URL, merge_commit_sha: MERGE });
      readBinding.mockResolvedValueOnce({ status });
      expect(await read()).toMatchObject({ merged: true });
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
    expect(await read()).toMatchObject({ merged: true });
    readBinding.mockResolvedValueOnce({
      ...answer,
      head: { ...answer.head, repo: { full_name: 'other/aflow' } },
    });
    readBinding.mockResolvedValueOnce({ status: 'diverged' });
    expect(await read()).toMatchObject({ merged: false });
  });
  it('refuses absent publication records and arbitrary hosts', async () => {
    expect(await read(URL.replace('github.com', 'example.com'))).toMatchObject({ merged: false });
    execute.mockResolvedValueOnce([]);
    expect(await read()).toMatchObject({ merged: false });
    expect(readBinding).not.toHaveBeenCalledWith(
      expect.anything(),
      'compareCommits',
      expect.anything(),
    );
  });
  it('refuses an agent task posing as a publication commit', async () => {
    task.mockImplementation(async (_db, _tenant, _run, taskId) => ({
      status: 'succeeded',
      operationId: taskId === 'commit' ? 'agent.turn' : 'api.http.call',
      outputRef: taskId === 'commit' ? 'forged' : 'pr-record',
    }));
    expect(await read()).toMatchObject({ merged: false });
    expect(readBinding).not.toHaveBeenCalledWith(
      expect.anything(),
      'compareCommits',
      expect.anything(),
    );
  });
});

it.each([null, { merged: 'true' }])(
  'fails retryably on malformed GitHub responses %j',
  async (answer) => {
    readBinding.mockResolvedValue(answer);
    await expect(read()).rejects.toThrow('Invalid GitHub');
  },
);
it('propagates missing compareCommits and binding failures for a later wake', async () => {
  readBinding.mockResolvedValueOnce({
    merged: true,
    html_url: URL,
    head: { sha: 'c'.repeat(40) },
    merge_commit_sha: MERGE,
  });
  readBinding.mockRejectedValueOnce(new Error('Endpoint compareCommits unavailable'));
  await expect(read()).rejects.toThrow('compareCommits');
});

it('refuses an agent link to a PR absent from the platform publication output', async () => {
  retrieve.mockImplementation(async (ref) =>
    ref === 'pr-record' ? { prUrl: URL + '1' } : { commit: { sha: SHA, branch: 'aflow/work' } },
  );
  expect(await read()).toMatchObject({ merged: false });
  expect(readBinding).not.toHaveBeenCalledWith(
    expect.anything(),
    'compareCommits',
    expect.anything(),
  );
});

it('carries GitHub evidence and names the failed delivery fact', async () => {
  readBinding.mockResolvedValueOnce({
    merged: true,
    html_url: URL,
    merge_commit_sha: MERGE,
    merged_by: { login: 'operator' },
    merged_at: '2026-11-01T10:00:00Z',
    head: { sha: 'c'.repeat(40), ref: 'unrelated' },
  });
  readBinding.mockResolvedValueOnce({ status: 'diverged' });
  const answer = await read();
  expect(answer).toMatchObject({
    merged: false,
    reason: 'The merge does not deliver the recorded commit or branch.',
  });
  for (const line of [
    `Pull request: #160 ${URL}`,
    `Merge commit: ${MERGE}`,
    'Merged by: operator',
    'Merged at: 2026-11-01T10:00:00Z',
    `Recorded publication commit: ${SHA}`,
    'Recorded publication branch: aflow/work',
    'Merge delivers recorded commit or branch: not attested',
  ])
    expect(answer.evidence.split('\n')).toContain('- ' + line);
});

it('accepts a recorded branch delivered by squash without a recorded commit', async () => {
  retrieve.mockImplementation(async (ref) =>
    ref === 'pr-record' ? { prUrl: URL } : { commit: { branch: 'aflow/work' } },
  );
  expect(await read()).toMatchObject({ merged: true });
});
