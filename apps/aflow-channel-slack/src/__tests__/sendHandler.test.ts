/**
 * Plan 327 D2 and §6: the recipient is never chosen, a retry posts once, and a
 * repeat fails.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { ChannelMessageSendOutputSchema, toAgentToolError } from '@aflow/schemas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHANNEL_MESSAGE_REPEATED_CODE,
  CHANNEL_PROVIDER_ERROR_CODE,
  CHANNEL_RECIPIENT_NOT_LINKED_CODE,
  ChannelMessageSendHandler,
} from '../sendHandler.js';
import { SlackApiError, type SlackClient } from '../slack.js';
import { ChannelStore } from '../store.js';

const TENANT = 'tenant-1';
const OWNER = 'owner-1';

interface FakeSlack extends SlackClient {
  posts: Array<{ channel: string; text: string }>;
  failNext?: SlackApiError;
}

function fakeSlack(): FakeSlack {
  const slack: FakeSlack = {
    posts: [],
    openDirectMessage: (userId) => Promise.resolve(`D-${userId}`),
    postMessage: (channel, text) => {
      if (slack.failNext !== undefined) {
        const error = slack.failNext;
        delete slack.failNext;
        return Promise.reject(error);
      }
      slack.posts.push({ channel, text });
      return Promise.resolve({ channel, ts: `17000000${String(slack.posts.length)}.000100` });
    },
    openSocketModeUrl: () => Promise.resolve('wss://example.invalid'),
  };
  return slack;
}

let dir: string;
let store: ChannelStore;
let slack: FakeSlack;
let handler: ChannelMessageSendHandler;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'channel-slack-send-'));
  store = ChannelStore.open(join(dir, 'store.json'));
  store.linkWithCode('a'.repeat(64), {
    slackUserId: 'U-OPERATOR',
    aflowUserId: OWNER,
    tenantId: TENANT,
    linkedAt: new Date().toISOString(),
  });
  slack = fakeSlack();
  handler = new ChannelMessageSendHandler({ store, slack });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function send(
  input: unknown,
  scope: { executionId?: string; runId?: string; owner?: string; tenantId?: string } = {},
): Promise<{ result: StepResult; written: unknown }> {
  let written: unknown;
  const ctx = {
    tenantId: scope.tenantId ?? TENANT,
    runId: scope.runId ?? 'run-1',
    stepExecutionId: 'step-attempt',
    logicalExecutionId: scope.executionId ?? 'exec-1',
    attempt: 1,
    job: {
      operationId: 'channel.message.send',
      inputRef: 'inline:input',
      ...(scope.owner === '' ? {} : { credentialOwnerId: scope.owner ?? OWNER }),
    },
    readPayload: () => Promise.resolve(input),
    writePayload: (_kind: string, data: unknown) => {
      written = data;
      return Promise.resolve('inline:output');
    },
  } as unknown as ExecutorContext;
  return { result: await handler.execute(ctx), written };
}

function errorCode(result: StepResult): string | undefined {
  return result.status === 'FAILED' ? result.error.code : undefined;
}

describe('channel.message.send', () => {
  it('posts the text to the linked operator and returns its messageRef', async () => {
    const { result, written } = await send({ text: 'The deploy waits on your approval.' });

    expect(result.status).toBe('SUCCEEDED');
    const output = ChannelMessageSendOutputSchema.parse(written);
    expect(output.delivered).toBe(true);
    expect(output.messageRef).toBe('slack:D-U-OPERATOR:170000001.000100');
    expect(slack.posts).toEqual([
      { channel: 'D-U-OPERATOR', text: 'The deploy waits on your approval.' },
    ]);
  });

  it('returns the first messageRef to a retried step and posts nothing', async () => {
    const first = await send({ text: 'Approve the push.' });
    const retried = await send({ text: 'Approve the push.' });

    expect(retried.result.status).toBe('SUCCEEDED');
    expect(retried.written).toEqual(first.written);
    expect(slack.posts).toHaveLength(1);
  });

  it('keeps the retry rule across a restart, because the record is in the store', async () => {
    const first = await send({ text: 'Approve the push.' });
    handler = new ChannelMessageSendHandler({
      store: ChannelStore.open(join(dir, 'store.json')),
      slack,
    });
    const retried = await send({ text: 'Approve the push.' });

    expect(retried.written).toEqual(first.written);
    expect(slack.posts).toHaveLength(1);
  });

  it('fails a second send of the same text in the same run, and the first is the only post', async () => {
    await send({ text: 'Approve the push.' });
    const repeat = await send({ text: 'Approve the push.' }, { executionId: 'exec-2' });

    expect(errorCode(repeat.result)).toBe(CHANNEL_MESSAGE_REPEATED_CODE);
    expect(repeat.result.status === 'FAILED' && repeat.result.error.retryable).toBe(false);
    expect(slack.posts).toHaveLength(1);
  });

  it('sends the same text again from another run', async () => {
    await send({ text: 'Approve the push.' });
    const other = await send(
      { text: 'Approve the push.' },
      { executionId: 'exec-2', runId: 'run-2' },
    );

    expect(other.result.status).toBe('SUCCEEDED');
    expect(slack.posts).toHaveLength(2);
  });

  it.each([
    ['another person’s run', { owner: 'someone-else' }],
    ['a run with no person behind it', { owner: '' }],
    ['the same person in another tenant', { tenantId: 'tenant-2' }],
  ])('refuses %s with a teaching error naming setup and the help article', async (_case, scope) => {
    const { result } = await send({ text: 'Hello.' }, scope);

    expect(errorCode(result)).toBe(CHANNEL_RECIPIENT_NOT_LINKED_CODE);
    if (result.status !== 'FAILED') throw new Error('expected a failure');
    expect(result.error.message).toContain('yarn channel:slack setup');
    expect(result.error.message).toContain('/help/slack-channel');
    expect(result.error.message).not.toContain('Settings → Channels');
    expect(toAgentToolError(result.error).retry).toBe(false);
    expect(slack.posts).toEqual([]);
  });

  it('refuses every send before anyone linked', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'channel-slack-unlinked-'));
    handler = new ChannelMessageSendHandler({
      store: ChannelStore.open(join(empty, 'store.json')),
      slack,
    });
    const { result } = await send({ text: 'Hello.' });
    rmSync(empty, { recursive: true, force: true });

    expect(errorCode(result)).toBe(CHANNEL_RECIPIENT_NOT_LINKED_CODE);
    expect(slack.posts).toEqual([]);
  });

  it('carries a provider error the existing step retry can act on, and records nothing', async () => {
    slack.failNext = new SlackApiError('chat.postMessage', 'ratelimited', true);
    const failed = await send({ text: 'Hello.' });

    expect(errorCode(failed.result)).toBe(CHANNEL_PROVIDER_ERROR_CODE);
    expect(failed.result.status === 'FAILED' && failed.result.error.retryable).toBe(true);

    const retried = await send({ text: 'Hello.' });
    expect(retried.result.status).toBe('SUCCEEDED');
    expect(slack.posts).toHaveLength(1);
  });

  it('accepts no recipient in its input', async () => {
    const { result } = await send({ text: 'Hello.', channel: 'C-ELSEWHERE' });

    expect(errorCode(result)).toBe('INVALID_INPUT');
    expect(slack.posts).toEqual([]);
  });
});
