/**
 * Plan 327 D2 and D3: `channel.message.send` with an `itemId` reads the item in
 * the run's space and posts it as a card. A high-tier approval and a plan
 * decision sent the same way show no buttons. Every call out ends when the
 * step's signal does, so the step's timeout cannot turn a post in flight into
 * a retryable timeout that posts it again.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHANNEL_DELIVERY_UNKNOWN_CODE,
  CHANNEL_ITEM_NOT_FOUND_CODE,
  CHANNEL_ITEM_NOT_OPEN_CODE,
  CHANNEL_ITEM_UNREADABLE_CODE,
  CHANNEL_MESSAGE_REPEATED_CODE,
  CHANNEL_PROVIDER_ERROR_CODE,
  ChannelMessageSendHandler,
} from '../sendHandler.js';
import { createSlackClient } from '../slack.js';
import { ChannelStore } from '../store.js';
import {
  SPACE,
  buttonsOf,
  errorOf,
  fakeApi,
  linkOperator,
  makeItem,
  recordingSlack,
  sendStep,
  textOf,
  writeApproval,
  type FakeApi,
  type RecordingSlack,
} from './cardFixtures.js';

let dir: string;
let store: ChannelStore;
let slack: RecordingSlack;
let api: FakeApi;
let handler: ChannelMessageSendHandler;

const planDecision = makeItem({
  id: 'plan-decision:4f1b6a8e-1d2c-4a8b-9c3d-2e1f0a9b8c7d',
  kind: 'human_input',
  origin: { type: 'plan_decision', nodeId: '4f1b6a8e-1d2c-4a8b-9c3d-2e1f0a9b8c7d', revision: 3 },
  title: 'Choose the launch region',
  resolutionSchema: { type: 'string', enum: ['eu', 'us'] },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'channel-slack-card-'));
  store = ChannelStore.open(join(dir, 'store.json'));
  linkOperator(store);
  slack = recordingSlack();
  api = fakeApi(writeApproval('medium'), planDecision);
  api.items.set('wf-high', { ...writeApproval('high'), id: 'wf-high' });
  handler = new ChannelMessageSendHandler({ store, slack, api });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const MEDIUM = writeApproval('medium').id;

describe('a send with an itemId', () => {
  it('posts a medium write approval of a workflow task as a card with its preview and Approve or Deny', async () => {
    const { result, written } = await sendStep(handler, {
      text: 'The release skill waits on your approval.',
      itemId: MEDIUM,
    });

    expect(result.status).toBe('SUCCEEDED');
    expect(api.reads).toEqual([expect.objectContaining({ spaceId: SPACE, itemId: MEDIUM })]);
    const [post] = slack.posts;
    expect(post?.text).toBe('The release skill waits on your approval.');
    expect(buttonsOf(post?.blocks)).toEqual(['approve', 'reject']);
    expect(textOf(post?.blocks)).toContain('POST api.github.com');
    expect(written).toEqual({
      delivered: true,
      messageRef: `slack:${post?.channel}:1700000000.001`,
    });

    const card = store.cardAt(post?.channel ?? '', '1700000000.001');
    expect(card?.itemId).toBe(MEDIUM);
    expect(card?.origin).toEqual(writeApproval('medium').origin);
    expect(card?.controls.map((control) => control.id)).toEqual(['approve', 'reject']);
  });

  it('shows a high-tier approval sent the same way with no buttons', async () => {
    const { result } = await sendStep(handler, { text: 'A push waits on you.', itemId: 'wf-high' });

    expect(result.status).toBe('SUCCEEDED');
    const [post] = slack.posts;
    expect(buttonsOf(post?.blocks)).toEqual([]);
    expect(textOf(post?.blocks)).toContain('it needs you at Aflow');
    expect(store.cardAt(post?.channel ?? '', '1700000000.001')?.controls).toEqual([]);
  });

  it('shows a plan decision sent the same way with no buttons, saying it needs the operator at Aflow', async () => {
    const { result } = await sendStep(handler, {
      text: 'The plan waits on a decision.',
      itemId: planDecision.id,
    });

    expect(result.status).toBe('SUCCEEDED');
    const [post] = slack.posts;
    expect(buttonsOf(post?.blocks)).toEqual([]);
    expect(textOf(post?.blocks)).toContain('Choose the launch region');
    expect(textOf(post?.blocks)).toContain('it needs you at Aflow');
  });

  it('refuses an item not in the run’s space, and posts nothing', async () => {
    const { result } = await sendStep(handler, { text: 'Look.', itemId: 'step:elsewhere' });

    expect(errorOf(result)).toMatchObject({ code: CHANNEL_ITEM_NOT_FOUND_CODE, retryable: false });
    expect(slack.posts).toEqual([]);
  });

  it('refuses an item already decided, and posts nothing', async () => {
    api.items.set('step:done', makeItem({ id: 'step:done', status: 'resolved' }));
    const { result } = await sendStep(handler, { text: 'Look.', itemId: 'step:done' });

    expect(errorOf(result)).toMatchObject({ code: CHANNEL_ITEM_NOT_OPEN_CODE, retryable: false });
    expect(slack.posts).toEqual([]);
  });

  it('refuses an item from a run that carries no space', async () => {
    const { result } = await sendStep(
      handler,
      { text: 'Look.', itemId: MEDIUM },
      { spaceId: null },
    );

    expect(errorOf(result).code).toBe(CHANNEL_ITEM_UNREADABLE_CODE);
    expect(api.reads).toEqual([]);
    expect(slack.posts).toEqual([]);
  });

  it('keeps an API that did not answer retryable, because nothing was claimed or posted', async () => {
    api.readItem = () =>
      Promise.resolve({
        ok: false,
        status: 0,
        error: 'UNREACHABLE',
        message: 'Aflow did not answer.',
        retryable: true,
      });
    const failed = await sendStep(handler, { text: 'Look.', itemId: MEDIUM });

    expect(errorOf(failed.result)).toMatchObject({
      code: CHANNEL_ITEM_UNREADABLE_CODE,
      retryable: true,
    });
    expect(slack.posts).toEqual([]);
  });

  it('counts the same text with the same item as a repeat, and with another item as new', async () => {
    await sendStep(handler, { text: 'This waits on you.', itemId: MEDIUM }, { executionId: 'e-1' });
    const other = await sendStep(
      handler,
      { text: 'This waits on you.', itemId: 'wf-high' },
      { executionId: 'e-2' },
    );
    const repeat = await sendStep(
      handler,
      { text: 'This waits on you.', itemId: MEDIUM },
      { executionId: 'e-3' },
    );

    expect(other.result.status).toBe('SUCCEEDED');
    expect(errorOf(repeat.result).code).toBe(CHANNEL_MESSAGE_REPEATED_CODE);
    expect(slack.posts).toHaveLength(2);
  });
});

describe('the step’s timeout and abort', () => {
  /** A Slack that answers `conversations.open` and holds `chat.postMessage` until aborted. */
  function stallingSlack(stallOn: 'conversations.open' | 'chat.postMessage', posts: string[]) {
    return createSlackClient({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      fetchImpl: (url, init) => {
        const method = String(url).split('/').pop() ?? '';
        if (method === 'chat.postMessage') posts.push(method);
        if (method !== stallOn) {
          return Promise.resolve(
            method === 'conversations.open'
              ? Response.json({ ok: true, channel: { id: 'D-1' } })
              : Response.json({ ok: true, channel: 'D-1', ts: '1.0001' }),
          );
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error);
          });
        });
      },
    });
  }

  it('ends a post in flight when the step’s signal aborts, failing it not retryable as of unknown outcome', async () => {
    const posts: string[] = [];
    handler = new ChannelMessageSendHandler({
      store,
      slack: stallingSlack('chat.postMessage', posts),
      api,
    });
    const step = new AbortController();
    const sent = sendStep(handler, { text: 'Approve the push.' }, { signal: step.signal });
    setTimeout(() => {
      step.abort(new Error('the step ran out of time'));
    }, 20);

    const { result } = await sent;
    expect(errorOf(result)).toMatchObject({
      code: CHANNEL_DELIVERY_UNKNOWN_CODE,
      retryable: false,
    });

    const retried = await sendStep(handler, { text: 'Approve the push.' });
    expect(errorOf(retried.result).code).toBe(CHANNEL_DELIVERY_UNKNOWN_CODE);
    expect(posts).toHaveLength(1);
  });

  it('keeps an abort before the post retryable, because nothing was posted', async () => {
    const posts: string[] = [];
    handler = new ChannelMessageSendHandler({
      store,
      slack: stallingSlack('conversations.open', posts),
      api,
    });
    const step = new AbortController();
    const sent = sendStep(handler, { text: 'Hello.' }, { signal: step.signal });
    setTimeout(() => {
      step.abort(new Error('the step ran out of time'));
    }, 20);

    const { result } = await sent;
    expect(errorOf(result)).toMatchObject({ code: CHANNEL_PROVIDER_ERROR_CODE, retryable: true });
    expect(posts).toEqual([]);
  });

  it('sends nothing to Slack once the step’s signal has already ended', async () => {
    const posts: string[] = [];
    handler = new ChannelMessageSendHandler({
      store,
      slack: stallingSlack('chat.postMessage', posts),
      api,
    });
    const step = new AbortController();
    step.abort(new Error('cancelled'));

    const { result } = await sendStep(handler, { text: 'Hello.' }, { signal: step.signal });
    expect(errorOf(result)).toMatchObject({ code: CHANNEL_PROVIDER_ERROR_CODE, retryable: true });
    expect(posts).toEqual([]);
  });

  it('hands the step’s signal to the item read', async () => {
    const step = new AbortController();
    await sendStep(handler, { text: 'Look.', itemId: MEDIUM }, { signal: step.signal });
    expect(api.reads[0]?.signal).toBe(step.signal);
  });
});
