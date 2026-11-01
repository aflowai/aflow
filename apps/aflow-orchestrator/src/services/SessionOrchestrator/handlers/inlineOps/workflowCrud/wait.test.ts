/**
 * `workflow.wait` (Plan 339 D1) as the conversation calls it: the pull request
 * subject it names is normalised to the one the source emits, `since` is read
 * as a time to catch up from, and a wait whose event fired already ends in
 * its own output.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { emitPullRequestChanged } from '@aflow/cybernetic-runtime';
import { WorkflowWaitOutputSchema } from '@aflow/schemas';
import type { InlineHandlerArgs } from '../types.js';

const { success, error } = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../helpers.js', () => ({ emitStepSuccess: success, emitStepError: error }));
const { handleWorkflowWait } = await import('./wait.js');

const TENANT = 'a0000000-0000-4000-8000-000000000339';
const SPACE = '5e1d0000-0000-4000-8000-000000000339';
const SESSION = 'c0ffee00-0000-4000-8000-000000000339';

let redis: Redis;

function args(): InlineHandlerArgs {
  return {
    redis,
    context: { tenantId: TENANT, spaceId: SPACE, runId: SESSION },
  } as unknown as InlineHandlerArgs;
}

function output() {
  return WorkflowWaitOutputSchema.parse(success.mock.calls.at(-1)?.[1]);
}

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  success.mockClear();
  error.mockClear();
});

describe('workflow.wait', () => {
  it('names a pull request by the subject the source emits, from its link', async () => {
    await handleWorkflowWait(
      args(),
      {
        kind: 'pull_request.changed',
        subject: 'https://github.com/AflowAI/Aflow/pull/276',
        windowSeconds: 600,
      },
      Date.now(),
    );

    expect(error).not.toHaveBeenCalled();
    expect(output()).toMatchObject({
      kind: 'pull_request.changed',
      subject: 'aflowai/aflow#276',
      state: 'waiting',
    });
  });

  it('refuses a pull request subject it cannot read, and declares nothing', async () => {
    await handleWorkflowWait(
      args(),
      { kind: 'pull_request.changed', subject: 'the open one', windowSeconds: 600 },
      Date.now(),
    );

    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      'INVALID_WAIT',
      expect.stringContaining('owner/repo#number'),
      expect.any(Number),
      'validation',
    );
  });

  it('refuses a since that is no time', async () => {
    await handleWorkflowWait(
      args(),
      { kind: 'run.ended', subject: 'run-1', windowSeconds: 600, since: 'yesterday' },
      Date.now(),
    );

    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      'INVALID_WAIT',
      expect.stringContaining('since'),
      expect.any(Number),
      'validation',
    );
  });

  it('ends at once where an event fired since the time it names, with the event in its output', async () => {
    const before = new Date(Date.now() - 60_000).toISOString();
    await emitPullRequestChanged(redis, {
      tenantId: TENANT,
      spaceId: SPACE,
      subject: 'aflowai/aflow#276',
      change: 'checks_green',
      url: 'https://github.com/aflowai/aflow/pull/276',
      headSha: 'abc123',
    });

    await handleWorkflowWait(
      args(),
      {
        kind: 'pull_request.changed',
        subject: 'aflowai/aflow#276',
        windowSeconds: 600,
        since: before,
      },
      Date.now(),
    );

    const ended = output();
    expect(ended.state).toBe('ended');
    expect(ended.outcome).toMatchObject({
      endedBy: 'event',
      event: { subject: 'aflowai/aflow#276', detail: { change: 'checks_green' } },
    });
    expect(Date.parse(ended.closesAt)).toBeGreaterThan(Date.now());
  });

  it('keeps waiting where the event fired before it and it names no since', async () => {
    await emitPullRequestChanged(redis, {
      tenantId: TENANT,
      spaceId: SPACE,
      subject: 'aflowai/aflow#276',
      change: 'checks_green',
      url: 'https://github.com/aflowai/aflow/pull/276',
      headSha: 'abc123',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await handleWorkflowWait(
      args(),
      { kind: 'pull_request.changed', subject: 'aflowai/aflow#276', windowSeconds: 600 },
      Date.now(),
    );

    expect(output()).toMatchObject({ state: 'waiting' });
    expect(output().outcome).toBeUndefined();
  });
});
