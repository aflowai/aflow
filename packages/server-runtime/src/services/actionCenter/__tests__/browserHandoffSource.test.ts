/**
 * A browser hand-off as an Action Center item: one per site however many runs
 * wait on it, gone when they stop waiting, and a Done that reaches every one of
 * them — through the operator's resolve route, which is the only way to it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  browserHandoffKey,
  joinBrowserHandoff,
  type JoinBrowserHandoffInput,
  leaveBrowserHandoff,
} from '@aflow/redis';
import { ActionCenterItemSchema, StreamKeys } from '@aflow/schemas';

import { projectActionCenterItem } from '../authz.js';
import { createBrowserHandoffSource } from '../sources/browserHandoffSource.js';
import { ActionCenterResolveError, type ActionCenterContext } from '../types.js';

const TENANT = '00000000-0000-0000-0000-000000000001';
const SPACE = '00000000-0000-0000-0000-0000000000a1';
const EDITOR = '00000000-0000-0000-0000-000000000005';

let redis: Redis;

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

function ctx(role: 'admin' | 'editor' | 'viewer' = 'editor'): ActionCenterContext {
  return {
    tenantId: TENANT as ActionCenterContext['tenantId'],
    spaceId: SPACE,
    actorUserId: EDITOR,
    actorSpaceRole: role,
    actorIsTenantAdmin: false,
  };
}

function source() {
  return createBrowserHandoffSource({ db: {} as never, redis, payloadStore: {} as never });
}

function waitOn(stepExecutionId: string, runId: string): JoinBrowserHandoffInput {
  const startedAt = Date.now();
  return {
    hostname: 'laptop',
    profileId: 'default',
    site: 'example.com',
    reason: 'sign_in',
    message: 'Sign in to the mail account; the run then reads the inbox.',
    startedAt,
    waiter: {
      tenantId: TENANT,
      spaceId: SPACE,
      runId,
      stepExecutionId,
      sessionId: runId,
      deadlineAt: startedAt + 15 * 60_000,
    },
  };
}

async function twoRunsWaiting(): Promise<void> {
  await joinBrowserHandoff(redis, waitOn('step-1', 'run-1'));
  await joinBrowserHandoff(redis, waitOn('step-2', 'run-2'));
}

describe('the browser hand-off source', () => {
  it('renders one item for two runs waiting on one site, with Done', async () => {
    await twoRunsWaiting();
    const items = await source().listOpen(ctx());

    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item?.kind).toBe('browser_handoff');
    expect(item?.title).toBe('Sign in to example.com');
    expect(item?.summary).toBe('Sign in to the mail account; the run then reads the inbox.');
    expect(item?.uiHints?.approveLabel).toBe('Done');
    expect(item?.origin).toMatchObject({
      type: 'browser_handoff',
      spaceId: SPACE,
      hostname: 'laptop',
      profileId: 'default',
      site: 'example.com',
      reason: 'sign_in',
    });
    const waiting = item?.origin.type === 'browser_handoff' ? item.origin.waiting : [];
    expect(waiting.map((w) => w.runId).sort()).toEqual(['run-1', 'run-2']);

    const projected = projectActionCenterItem(ctx(), item!);
    expect(ActionCenterItemSchema.parse(projected).allowedActions).toEqual(['approve']);
    expect(projectActionCenterItem(ctx('viewer'), item!).allowedActions).toEqual([]);
  });

  it('is found by its id, and not once its runs have stopped waiting', async () => {
    await twoRunsWaiting();
    const [item] = await source().listOpen(ctx());
    expect(await source().getById(ctx(), item!.id)).toMatchObject({ id: item!.id });

    const key = browserHandoffKey('laptop', 'default', 'example.com');
    for (const stepExecutionId of ['step-1', 'step-2']) {
      await leaveBrowserHandoff(redis, {
        key,
        hostname: 'laptop',
        tenantId: TENANT,
        spaceId: SPACE,
        stepExecutionId,
      });
    }
    expect(await source().listOpen(ctx())).toEqual([]);
    expect(await source().getById(ctx(), item!.id)).toBeNull();
  });

  it('sends Done to every step waiting on the item', async () => {
    await twoRunsWaiting();
    const [item] = await source().listOpen(ctx());
    const listener = redis.duplicate();
    const heard: string[] = [];
    listener.on('message', (channel: string) => heard.push(channel));
    await listener.subscribe(
      StreamKeys.browserHandoffDoneChannel('step-1'),
      StreamKeys.browserHandoffDoneChannel('step-2'),
    );

    const outcome = await source().resolve(ctx(), item!, { kind: 'approve' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(outcome.dispatchedOperationId).toBe('browser.page.handoff');
    expect(heard.sort()).toEqual([
      StreamKeys.browserHandoffDoneChannel('step-1'),
      StreamKeys.browserHandoffDoneChannel('step-2'),
    ]);
    // The executors take the record down as their waits end; Done does not.
    expect(await source().listOpen(ctx())).toHaveLength(1);
    await listener.unsubscribe();
    listener.disconnect();
  });

  it('takes down the line of a wait no executor is listening for any more', async () => {
    await twoRunsWaiting();
    const [item] = await source().listOpen(ctx());
    await source().resolve(ctx(), item!, { kind: 'approve' });
    expect(await source().listOpen(ctx())).toEqual([]);
  });

  it('answers to Done alone, and says so when the hand-off has ended', async () => {
    await twoRunsWaiting();
    const [item] = await source().listOpen(ctx());
    await expect(source().resolve(ctx(), item!, { kind: 'reject' })).rejects.toMatchObject({
      code: 'INVALID_RESOLUTION',
    });

    await source().resolve(ctx(), item!, { kind: 'approve' });
    const stale = await source()
      .resolve(ctx(), item!, { kind: 'approve' })
      .catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(ActionCenterResolveError);
    expect((stale as ActionCenterResolveError).code).toBe('STALE_ACTION_CENTER_ITEM');
  });
});

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', '.next', '__tests__'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function naming(pattern: RegExp): string[] {
  return ['apps', 'packages']
    .flatMap((root) => sources(join(REPO, root)))
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(REPO, file))
    .sort();
}

describe('Done on a browser hand-off', () => {
  // The host identity's channel grant would let it publish Done — Redis has no
  // subscribe-only grant — so what holds is the code: no surface an agent
  // reaches publishes it.
  it('is published in code by this source alone and heard by the host executor alone', () => {
    expect(naming(/browserHandoffDoneChannel/)).toEqual([
      'apps/aflow-executor-host/src/browser/handoffBoard.ts',
      'packages/schemas/src/runtime/streamMessages.ts',
      'packages/server-runtime/src/services/actionCenter/sources/browserHandoffSource.ts',
    ]);
    const board = readFileSync(
      join(REPO, 'apps/aflow-executor-host/src/browser/handoffBoard.ts'),
      'utf8',
    );
    expect(board).not.toMatch(/\.publish\(/);
  });

  it('is spelled out only where it is defined and granted, so nothing publishes around the helper', () => {
    expect(naming(/handoff-done/)).toEqual([
      'packages/schemas/src/runtime/streamMessages.ts',
      'packages/server-runtime/src/bootstrap/redisAcl.ts',
    ]);
  });

  it('reaches the source only through the operator’s authenticated resolve route', () => {
    // An item is resolved by the aggregator, and the aggregator is asked to
    // resolve by that route and nothing else — no operation, so no agent.
    expect(naming(/\baggregator\.resolve\(/)).toEqual([
      'packages/server-runtime/src/routes/action-center.ts',
    ]);
    expect(naming(/createBrowserHandoffSource\(/)).toEqual([
      'packages/server-runtime/src/services/actionCenter/buildSpaceAggregator.ts',
      'packages/server-runtime/src/services/actionCenter/sources/browserHandoffSource.ts',
    ]);
  });
});
