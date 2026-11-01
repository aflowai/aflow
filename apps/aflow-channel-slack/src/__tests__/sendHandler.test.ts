/**
 * Plan 327 D2 and §6: the recipient is never chosen, a retry posts once, each run
 * of a workflow task posts its own message, a post with no answer is never sent
 * twice, and a repeat fails.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { ChannelMessageSendOutputSchema, toAgentToolError } from '@aflow/schemas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHANNEL_DELIVERY_UNKNOWN_CODE,
  CHANNEL_MESSAGE_REPEATED_CODE,
  CHANNEL_PROVIDER_ERROR_CODE,
  CHANNEL_RECIPIENT_NOT_LINKED_CODE,
  ChannelMessageSendHandler,
} from '../sendHandler.js';
import { SlackApiError, createSlackClient, type SlackClient } from '../slack.js';
import { ChannelStore } from '../store.js';

const TENANT = 'tenant-1';
const OWNER = 'owner-1';

interface FakeSlack extends SlackClient {
  posts: Array<{ channel: string; text: string }>;
  failNext?: SlackApiError;
  /** Slack takes the post, then the answer is lost with this error. */
  failAfterPost?: SlackApiError;
  failOpen?: SlackApiError;
}

function fakeSlack(): FakeSlack {
  const slack: FakeSlack = {
    posts: [],
    openDirectMessage: (userId) => {
      if (slack.failOpen !== undefined) {
        const error = slack.failOpen;
        delete slack.failOpen;
        return Promise.reject(error);
      }
      return Promise.resolve(`D-${userId}`);
    },
    postMessage: (channel, text) => {
      if (slack.failNext !== undefined) {
        const error = slack.failNext;
        delete slack.failNext;
        return Promise.reject(error);
      }
      slack.posts.push({ channel, text });
      if (slack.failAfterPost !== undefined) {
        const error = slack.failAfterPost;
        delete slack.failAfterPost;
        return Promise.reject(error);
      }
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

  it('posts again from a second run of the same workflow task, and a retry within a run posts nothing', async () => {
    const task = { executionId: 'task:notify-operator' };
    const firstRun = await send(
      { text: 'The nightly report is ready.' },
      { ...task, runId: 'wr-1' },
    );
    const secondRun = await send(
      { text: 'The nightly report is ready.' },
      { ...task, runId: 'wr-2' },
    );
    const retriedInSecondRun = await send(
      { text: 'The nightly report is ready.' },
      { ...task, runId: 'wr-2' },
    );

    expect(secondRun.result.status).toBe('SUCCEEDED');
    expect(secondRun.written).not.toEqual(firstRun.written);
    expect(retriedInSecondRun.result.status).toBe('SUCCEEDED');
    expect(retriedInSecondRun.written).toEqual(secondRun.written);
    expect(slack.posts).toHaveLength(2);
  });

  it('fails a timeout after Slack took the post as not retryable, and never posts it twice', async () => {
    slack.failAfterPost = new SlackApiError(
      'chat.postMessage',
      'The operation was aborted due to timeout',
      true,
      true,
    );
    const timedOut = await send({ text: 'Approve the push.' });

    expect(errorCode(timedOut.result)).toBe(CHANNEL_DELIVERY_UNKNOWN_CODE);
    if (timedOut.result.status !== 'FAILED') throw new Error('expected a failure');
    expect(timedOut.result.error.retryable).toBe(false);
    expect(timedOut.result.error.message).toContain('may have posted it');

    const retried = await send({ text: 'Approve the push.' });
    const resent = await send({ text: 'Approve the push.' }, { executionId: 'exec-2' });

    expect(errorCode(retried.result)).toBe(CHANNEL_DELIVERY_UNKNOWN_CODE);
    expect(errorCode(resent.result)).toBe(CHANNEL_DELIVERY_UNKNOWN_CODE);
    expect(slack.posts).toHaveLength(1);
  });

  it.each([
    [
      'an HTTP 504 from a gateway after Slack took the post',
      () => new Response('', { status: 504 }),
    ],
    [
      'a 200 whose body could not be read before the timeout',
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(
                new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
              );
            },
          }),
          { status: 200 },
        ),
    ],
  ])(
    'fails %s as of unknown outcome, records it, and never posts it twice',
    async (_case, answer) => {
      const posts: string[] = [];
      handler = new ChannelMessageSendHandler({
        store,
        slack: createSlackClient({
          botToken: 'xoxb-test',
          appToken: 'xapp-test',
          fetchImpl: (url) => {
            if (String(url).endsWith('/conversations.open')) {
              return Promise.resolve(Response.json({ ok: true, channel: { id: 'D-1' } }));
            }
            posts.push(String(url));
            return Promise.resolve(answer());
          },
        }),
      });

      const lost = await send({ text: 'Approve the push.' });
      if (lost.result.status !== 'FAILED') throw new Error('expected a failure');
      expect(lost.result.error.code).toBe(CHANNEL_DELIVERY_UNKNOWN_CODE);
      expect(lost.result.error.retryable).toBe(false);

      const retried = await send({ text: 'Approve the push.' });
      const resent = await send({ text: 'Approve the push.' }, { executionId: 'exec-2' });

      expect(errorCode(retried.result)).toBe(CHANNEL_DELIVERY_UNKNOWN_CODE);
      expect(errorCode(resent.result)).toBe(CHANNEL_DELIVERY_UNKNOWN_CODE);
      expect(posts).toHaveLength(1);
    },
  );

  it('keeps an HTTP 5xx from conversations.open retryable, because nothing was posted', async () => {
    let openFails = true;
    const posts: string[] = [];
    handler = new ChannelMessageSendHandler({
      store,
      slack: createSlackClient({
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        fetchImpl: (url) => {
          if (String(url).endsWith('/conversations.open')) {
            if (openFails) {
              openFails = false;
              return Promise.resolve(new Response('', { status: 503 }));
            }
            return Promise.resolve(Response.json({ ok: true, channel: { id: 'D-1' } }));
          }
          posts.push(String(url));
          return Promise.resolve(Response.json({ ok: true, channel: 'D-1', ts: '1.0001' }));
        },
      }),
    });

    const failed = await send({ text: 'Hello.' });
    expect(errorCode(failed.result)).toBe(CHANNEL_PROVIDER_ERROR_CODE);
    expect(failed.result.status === 'FAILED' && failed.result.error.retryable).toBe(true);

    const retried = await send({ text: 'Hello.' });
    expect(retried.result.status).toBe('SUCCEEDED');
    expect(posts).toHaveLength(1);
  });

  it('posts once when two sends of the same text in one run arrive together', async () => {
    const [first, second] = await Promise.all([
      send({ text: 'Approve the push.' }, { executionId: 'exec-1' }),
      send({ text: 'Approve the push.' }, { executionId: 'exec-2' }),
    ]);

    expect(first.result.status).toBe('SUCCEEDED');
    expect(errorCode(second.result)).toBe(CHANNEL_MESSAGE_REPEATED_CODE);
    expect(second.result.status === 'FAILED' && second.result.error.retryable).toBe(false);
    expect(slack.posts).toHaveLength(1);

    const later = await send({ text: 'Approve the push.' }, { executionId: 'exec-3' });
    expect(errorCode(later.result)).toBe(CHANNEL_MESSAGE_REPEATED_CODE);
    expect(slack.posts).toHaveLength(1);
  });

  it('posts once when the same step arrives twice at once, and the retry returns its messageRef', async () => {
    const [first, duplicate] = await Promise.all([
      send({ text: 'Approve the push.' }),
      send({ text: 'Approve the push.' }),
    ]);

    expect(first.result.status).toBe('SUCCEEDED');
    expect(errorCode(duplicate.result)).toBe(CHANNEL_MESSAGE_REPEATED_CODE);

    const retried = await send({ text: 'Approve the push.' });
    expect(retried.written).toEqual(first.written);
    expect(slack.posts).toHaveLength(1);
  });

  it('keeps a transport failure before the post retryable, because nothing was posted', async () => {
    slack.failOpen = new SlackApiError('conversations.open', 'fetch failed', true, true);
    const failed = await send({ text: 'Hello.' });

    expect(errorCode(failed.result)).toBe(CHANNEL_PROVIDER_ERROR_CODE);
    expect(failed.result.status === 'FAILED' && failed.result.error.retryable).toBe(true);

    const retried = await send({ text: 'Hello.' });
    expect(retried.result.status).toBe('SUCCEEDED');
    expect(slack.posts).toHaveLength(1);
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

describe('the Slack client', () => {
  it('marks a post whose answer never came as of unknown outcome, and a refusal as not', async () => {
    const timingOut = createSlackClient({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      fetchImpl: () =>
        Promise.reject(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        ),
    });
    const refusing = createSlackClient({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      fetchImpl: () => Promise.resolve(Response.json({ ok: false, error: 'ratelimited' })),
    });

    const lost = await timingOut.postMessage('D-1', 'Hello.').catch((error: unknown) => error);
    const refused = await refusing.postMessage('D-1', 'Hello.').catch((error: unknown) => error);

    expect(lost).toBeInstanceOf(SlackApiError);
    expect((lost as SlackApiError).outcomeUnknown).toBe(true);
    expect(refused).toBeInstanceOf(SlackApiError);
    expect((refused as SlackApiError).outcomeUnknown).toBe(false);
    expect((refused as SlackApiError).retryable).toBe(true);
  });

  it('marks an HTTP 5xx and an unreadable body as of unknown outcome, and a 429 as not', async () => {
    const answering = (answer: () => Response) =>
      createSlackClient({
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        fetchImpl: () => Promise.resolve(answer()),
      });

    const gateway = await answering(() => new Response('', { status: 504 }))
      .postMessage('D-1', 'Hello.')
      .catch((error: unknown) => error);
    const unreadable = await answering(() => new Response('<html>', { status: 200 }))
      .postMessage('D-1', 'Hello.')
      .catch((error: unknown) => error);
    const limited = await answering(() => new Response('', { status: 429 }))
      .postMessage('D-1', 'Hello.')
      .catch((error: unknown) => error);

    expect((gateway as SlackApiError).outcomeUnknown).toBe(true);
    expect((unreadable as SlackApiError).outcomeUnknown).toBe(true);
    expect((limited as SlackApiError).outcomeUnknown).toBe(false);
    expect((limited as SlackApiError).retryable).toBe(true);
  });
});
