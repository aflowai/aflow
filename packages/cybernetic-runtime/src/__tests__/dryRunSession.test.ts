/**
 * The one resolver every session-side hold decision reads. The session hash
 * only speeds up a hold. Every other answer comes from the session's durable
 * link and the run's row, and an unread link or row answers `unknown`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@aflow/database';
import type { Redis } from 'ioredis';

const mockGetSessionDryRunLink = vi.fn();
const mockReadDryRunSession = vi.fn();
const mockReadWorkflowRunDryRun = vi.fn();

vi.mock('@aflow/redis', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionDryRunLink: (...args: unknown[]) => mockGetSessionDryRunLink(...args),
}));

vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readDryRunSession: (...args: unknown[]) => mockReadDryRunSession(...args),
  readWorkflowRunDryRun: (...args: unknown[]) => mockReadWorkflowRunDryRun(...args),
}));

const { resolveSessionDryRun } = await import('../dryRunSession.js');

const TENANT = 'a0000000-0000-4000-8000-000000000001';
const SESSION = '00000000-0000-4000-8000-0000000000a1';
const RUN = '00000000-0000-4000-8000-0000000000a2';
const deps = { db: {} as Database, redis: {} as Redis };

beforeEach(() => {
  mockGetSessionDryRunLink.mockReset().mockResolvedValue(null);
  mockReadDryRunSession.mockReset().mockResolvedValue(null);
  mockReadWorkflowRunDryRun.mockReset().mockResolvedValue(false);
});

describe('resolveSessionDryRun', () => {
  it('holds at once on a hash that names the dry run, reading nothing else', async () => {
    expect(
      await resolveSessionDryRun(deps, TENANT, SESSION, { dryRunOf: RUN, dryRunTaskId: 't' }),
    ).toEqual({ kind: 'dry_run', runId: RUN, taskId: 't' });
    expect(mockReadDryRunSession).not.toHaveBeenCalled();
  });

  it('reads the raw hash fields when the caller has parsed no state', async () => {
    mockGetSessionDryRunLink.mockResolvedValue({ dryRunOf: RUN });
    expect(await resolveSessionDryRun(deps, TENANT, SESSION)).toEqual({
      kind: 'dry_run',
      runId: RUN,
    });
    expect(mockGetSessionDryRunLink).toHaveBeenCalledWith(deps.redis, TENANT, SESSION);
  });

  it.each([
    ['a null state (corrupt and quarantined, or deleted)', null],
    ['a state without its dry-run fields', {}],
  ] as const)('resolves %s from the link and the run row', async (_what, hash) => {
    mockReadDryRunSession.mockResolvedValue({ runId: RUN, taskId: 'record' });
    mockReadWorkflowRunDryRun.mockResolvedValue(true);

    expect(await resolveSessionDryRun(deps, TENANT, SESSION, hash)).toEqual({
      kind: 'dry_run',
      runId: RUN,
      taskId: 'record',
    });
    expect(mockReadDryRunSession).toHaveBeenCalledWith(deps.db, TENANT, SESSION);
    expect(mockReadWorkflowRunDryRun).toHaveBeenCalledWith(deps.db, TENANT, RUN);
  });

  it('falls back to the link when the raw hash read fails', async () => {
    mockGetSessionDryRunLink.mockRejectedValue(new Error('redis timeout'));
    mockReadDryRunSession.mockResolvedValue({ runId: RUN });
    mockReadWorkflowRunDryRun.mockResolvedValue(true);

    expect(await resolveSessionDryRun(deps, TENANT, SESSION)).toMatchObject({
      kind: 'dry_run',
      runId: RUN,
    });
  });

  it('answers live for a session with no link', async () => {
    expect(await resolveSessionDryRun(deps, TENANT, SESSION, null)).toEqual({ kind: 'live' });
    expect(mockReadWorkflowRunDryRun).not.toHaveBeenCalled();
  });

  it('answers live when the linked run row says the run is live', async () => {
    mockReadDryRunSession.mockResolvedValue({ runId: RUN });
    expect(await resolveSessionDryRun(deps, TENANT, SESSION, null)).toEqual({ kind: 'live' });
  });

  it('answers unknown when the link cannot be read', async () => {
    mockReadDryRunSession.mockRejectedValue(new Error('connection refused'));
    const answer = await resolveSessionDryRun(deps, TENANT, SESSION, null);
    expect(answer.kind).toBe('unknown');
    expect(answer.kind === 'unknown' ? answer.reason : '').toContain('connection refused');
  });

  it('answers unknown when the run row cannot be read', async () => {
    mockReadDryRunSession.mockResolvedValue({ runId: RUN });
    mockReadWorkflowRunDryRun.mockRejectedValue(new Error('no row'));
    const answer = await resolveSessionDryRun(deps, TENANT, SESSION, null);
    expect(answer.kind).toBe('unknown');
    expect(answer.kind === 'unknown' ? answer.reason : '').toContain(RUN);
  });
});
