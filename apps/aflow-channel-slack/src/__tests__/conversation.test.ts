/**
 * Plan 327 D4 and §6, P2: a message from the linked operator reaches the
 * Helmsman and the answer comes back in its thread. A reply in that thread
 * continues the same session. A redelivered event is handled once, a late
 * message asks before it runs, and a stranger's message is refused. The app's
 * real API client talks to a fake Aflow that keeps the session routes' rules.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONVERSATION_START_MODE, HELMSMAN_TARGET, createAflowApi } from '../aflowApi.js';
import { REPLY_DECIDES_NOTHING } from '../cardActions.js';
import type { ChannelSlackConfig } from '../config.js';
import {
  ANSWER_NOT_POSTED,
  CHECK_AT_AFLOW,
  CONVERSATION_ENDED,
  Conversations,
  LATE_ALREADY_DECIDED,
  LATE_DISCARD_ACTION,
  LATE_QUESTION,
  LATE_RUN_ACTION,
  MAYBE_SENT,
  MOVED_ON,
  NOT_THE_KEY_OWNER,
  STILL_ANSWERING,
  WAITS_AT_AFLOW,
  relayed,
  type ConversationResult,
  type WatchOutcome,
} from '../conversation.js';
import { answerInbound, answerTap, type InboundResult } from '../inbound.js';
import { CODE_ALREADY_USED_REPLY, STRANGER_REPLY } from '../linking.js';
import { SlackApiError } from '../slack.js';
import { ChannelStore } from '../store.js';
import { buttonsOf, makeItem, OPERATOR, OWNER, SPACE, recordingSlack } from './cardFixtures.js';
import type { RecordingSlack } from './cardFixtures.js';
import { directMessage, fakeAflow, type FakeAflow } from './conversationFixtures.js';
import { linkCodeSha256 } from '../../scripts/setup.mjs';

const NOW = new Date('2026-11-01T09:00:00.000Z');
const CODE = 'K7QM-2XRD';
const MINUTE = 60_000;

const config: ChannelSlackConfig = {
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_APP_TOKEN: 'xapp-test',
  AFLOW_API_URL: 'http://127.0.0.1:3000',
  AFLOW_API_KEY: 'phx_owner',
  AFLOW_TENANT_ID: 'tenant-1',
  AFLOW_USER_ID: OWNER,
  CHANNEL_REDIS_URL: 'redis://127.0.0.1:6379',
  CHANNEL_REDIS_PASSWORD: 'c'.repeat(64),
  CHANNEL_SLACK_LINK_CODE_SHA256: linkCodeSha256(CODE) as string,
  CHANNEL_SLACK_LINK_CODE_EXPIRES_AT: new Date(NOW.getTime() + MINUTE).toISOString(),
};

let dir: string;
let storePath: string;
let store: ChannelStore;
let slack: RecordingSlack;
let aflow: FakeAflow;
let conversations: Conversations;
let linkMessage: ReturnType<typeof directMessage>;

function deps() {
  const api = createAflowApi({
    apiUrl: config.AFLOW_API_URL,
    apiKey: config.AFLOW_API_KEY,
    fetchImpl: aflow.fetch,
  });
  return { store, slack, api, config, conversations, now: () => NOW };
}

function newConversations(): Conversations {
  return new Conversations({
    store,
    slack,
    api: createAflowApi({
      apiUrl: config.AFLOW_API_URL,
      apiKey: config.AFLOW_API_KEY,
      fetchImpl: aflow.fetch,
    }),
    aflowUserId: OWNER,
    now: () => NOW,
    sleep: () => Promise.resolve(),
    pollMs: 0,
    watchLimitMs: 0,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'channel-slack-talk-'));
  storePath = join(dir, 'store.json');
  store = ChannelStore.open(storePath, NOW);
  slack = recordingSlack();
  aflow = fakeAflow();
  conversations = newConversations();
  linkMessage = directMessage(OPERATOR, CODE, NOW, { eventId: 'Ev-link' });
  await answerInbound(linkMessage, deps());
  slack.posts.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Answers a message, and waits for the watch it started to post. */
async function send(message: ReturnType<typeof directMessage>): Promise<InboundResult> {
  const result = await answerInbound(message, deps());
  if ('watching' in result) await result.watching;
  return result;
}

async function tapLate(promptTs: string, actionId: string): Promise<ConversationResult> {
  const result = await answerTap(
    { slackUserId: OPERATOR, channel: `D-${OPERATOR}`, messageTs: promptTs, actionId },
    deps(),
  );
  if (typeof result === 'string') throw new Error(`a card answered the tap: ${result}`);
  await result.watching;
  return result;
}

describe('a direct message from the linked operator', () => {
  it('reaches the Helmsman, and the Helmsman replies in the message’s thread', async () => {
    const status = directMessage(OPERATOR, 'status?', NOW);

    expect((await send(status)).outcome).toBe('started');

    expect(aflow.starts).toHaveLength(1);
    expect(aflow.starts[0]).toEqual({
      spaceId: SPACE,
      body: { target: HELMSMAN_TARGET, mode: 'api', input: { input: 'status?' } },
      idempotencyKey: `slack-event:${status.eventId}`,
    });
    expect(slack.posts).toEqual([
      {
        channel: status.channel,
        text: 'The Helmsman answers: status?',
        threadTs: status.ts,
      },
    ]);
  });

  it('continues the same session from a reply in that thread', async () => {
    const status = directMessage(OPERATOR, 'status?', NOW);
    await send(status);
    const [session] = [...aflow.sessions.values()];
    const pausedAt = session?.pausedStep;

    const reply = directMessage(OPERATOR, 'why did the deploy fail?', NOW, {
      threadTs: status.ts,
    });
    expect((await send(reply)).outcome).toBe('continued');

    expect(aflow.starts).toHaveLength(1);
    expect(aflow.resumes).toEqual([
      {
        sessionId: session?.id,
        body: { stepExecutionId: pausedAt, input: { input: 'why did the deploy fail?' } },
      },
    ]);
    expect(slack.posts.at(-1)).toEqual({
      channel: status.channel,
      text: 'The Helmsman answers: why did the deploy fail?',
      threadTs: status.ts,
    });
    expect(store.threadAt(status.channel, status.ts)?.sessionId).toBe(session?.id);
  });

  it('meets the session routes’ rules: mode `api` from a key, and the paused step on a resume', async () => {
    const status = directMessage(OPERATOR, 'status?', NOW);
    await send(status);
    await send(directMessage(OPERATOR, 'and now?', NOW, { threadTs: status.ts }));
    await send(directMessage(OPERATOR, 'and then?', NOW, { threadTs: status.ts }));

    expect(CONVERSATION_START_MODE).toBe('api');
    expect(aflow.refusals).toEqual([]);
    expect(aflow.resumes).toHaveLength(2);
    expect(slack.posts.map((post) => post.text)).toEqual([
      'The Helmsman answers: status?',
      'The Helmsman answers: and now?',
      'The Helmsman answers: and then?',
    ]);
  });

  it('starts a second conversation from a second direct message, not a reply', async () => {
    await send(directMessage(OPERATOR, 'status?', NOW, { ageMs: 10_000 }));
    await send(directMessage(OPERATOR, 'what runs now?', NOW, { ageMs: 5_000 }));

    expect(aflow.sessions.size).toBe(2);
  });

  it('tells the operator to wait for an answer still on its way, and sends nothing', async () => {
    const status = directMessage(OPERATOR, 'status?', NOW);
    aflow.holdAnswers = true;
    const started = await answerInbound(status, deps());

    const early = await send(directMessage(OPERATOR, 'hello?', NOW, { threadTs: status.ts }));

    expect(early.outcome).toBe('busy');
    expect(aflow.resumes).toEqual([]);
    expect(slack.posts.at(-1)?.text).toBe(STILL_ANSWERING);
    aflow.answerHeld();
    if ('watching' in started) await started.watching;
  });

  it('says the conversation moved on when its pause changed at Aflow, and answers nothing', async () => {
    const status = directMessage(OPERATOR, 'status?', NOW);
    await send(status);
    const [session] = [...aflow.sessions.values()];
    aflow.movePause(session?.id ?? '');

    const reply = await send(directMessage(OPERATOR, 'go on', NOW, { threadTs: status.ts }));

    expect(reply.outcome).toBe('refused');
    expect(slack.posts.at(-1)?.text).toBe(MOVED_ON);
    // The next reply reads the pause again and continues from there.
    expect(
      (
        await send(
          directMessage(OPERATOR, 'go on', NOW, { threadTs: status.ts, eventId: 'Ev-again' }),
        )
      ).outcome,
    ).toBe('continued');
  });

  it('says so when the session has ended, and starts nothing', async () => {
    const status = directMessage(OPERATOR, 'status?', NOW);
    await send(status);
    const thread = store.threadAt(status.channel, status.ts);
    if (thread === undefined) throw new Error('no thread');
    store.updateThread(thread, { status: 'ended' }, NOW);

    expect(
      (await send(directMessage(OPERATOR, 'more', NOW, { threadTs: status.ts }))).outcome,
    ).toBe('ended');
    expect(slack.posts.at(-1)?.text).toBe(CONVERSATION_ENDED);
    expect(aflow.starts).toHaveLength(1);
  });

  it('acts only for the key’s own user', async () => {
    const other = new Conversations({
      store,
      slack,
      api: deps().api,
      aflowUserId: 'someone-else',
      now: () => NOW,
    });

    const result = await answerInbound(directMessage(OPERATOR, 'status?', NOW), {
      ...deps(),
      conversations: other,
    });

    expect(result.outcome).toBe('refused');
    expect(aflow.starts).toEqual([]);
    expect(slack.posts.at(-1)?.text).toBe(NOT_THE_KEY_OWNER);
  });

  it('leaves a reply under a card to the card: free text still approves nothing', async () => {
    const approval = makeItem();
    store.addCard({
      channel: `D-${OPERATOR}`,
      ts: '1700000000.009',
      itemId: approval.id,
      spaceId: SPACE,
      origin: approval.origin as Record<string, unknown>,
      title: approval.title,
      row: 'approval',
      controls: [
        {
          id: 'approve',
          label: 'Approve',
          resolution: { kind: 'approve' },
          decided: 'Approved',
        },
      ],
      head: [],
      text: approval.title,
      postedAt: NOW.toISOString(),
      outcome: null,
    });

    const result = await send(directMessage(OPERATOR, 'yes', NOW, { threadTs: '1700000000.009' }));

    expect(result.outcome).toBe('card_reply');
    expect(aflow.starts).toEqual([]);
    expect(slack.posts.at(-1)?.text).toBe(REPLY_DECIDES_NOTHING);
  });
});

describe('a redelivered event', () => {
  it('starts one conversation and posts one answer', async () => {
    const status = directMessage(OPERATOR, 'status?', NOW);

    await send(status);
    expect((await send(status)).outcome).toBe('duplicate');
    expect((await send({ ...status, eventId: 'Ev-other-id' })).outcome).toBe('duplicate');

    expect(aflow.starts).toHaveLength(1);
    expect(slack.posts).toHaveLength(1);
  });

  it('continues once from a redelivered reply', async () => {
    const status = directMessage(OPERATOR, 'status?', NOW);
    await send(status);
    const reply = directMessage(OPERATOR, 'more', NOW, { threadTs: status.ts });

    await send(reply);
    await send(reply);

    expect(aflow.resumes).toHaveLength(1);
    expect(slack.posts).toHaveLength(2);
  });

  it('does nothing when it is the link code: no second reply is posted', async () => {
    expect((await send(linkMessage)).outcome).toBe('duplicate');
    expect((await send({ ...linkMessage, eventId: 'Ev-link-other-id' })).outcome).toBe('duplicate');

    expect(slack.posts).toEqual([]);
    expect(store.link()?.slackUserId).toBe(OPERATOR);
  });

  it('never sends the link code to the Helmsman', async () => {
    const result = await send(directMessage(OPERATOR, CODE, NOW, { eventId: 'Ev-link-again' }));

    expect(result.outcome).toBe('code_used');
    expect(slack.posts.at(-1)?.text).toBe(CODE_ALREADY_USED_REPLY);
    expect(aflow.starts).toEqual([]);
  });

  it('posts no answer twice when the app restarts while it waited for one', async () => {
    const status = directMessage(OPERATOR, 'status?', NOW);
    aflow.holdAnswers = true;
    // This app's watch never wakes again, as one whose process stopped.
    const stopped = new Conversations({
      store,
      slack,
      api: deps().api,
      aflowUserId: OWNER,
      now: () => NOW,
      sleep: () => new Promise<void>(() => undefined),
      watchLimitMs: 60 * MINUTE,
    });
    await answerInbound(status, { ...deps(), conversations: stopped });
    aflow.answerHeld();

    // A fresh app watches the thread again, and a second one finds it answered.
    store = ChannelStore.open(storePath, NOW);
    const restarted = newConversations();
    await Promise.all(restarted.resumeWatching());
    await Promise.all(newConversations().resumeWatching());

    expect(slack.posts.filter((post) => post.text.startsWith('The Helmsman answers'))).toHaveLength(
      1,
    );
  });
});

describe('a thread whose watch stopped before the answer came', () => {
  function threadOf(message: ReturnType<typeof directMessage>) {
    const thread = store.threadAt(message.channel, message.ts);
    if (thread === undefined) throw new Error('no thread');
    return thread;
  }

  it('resumes no pause it has already resumed, so a reply while the Helmsman answers is held', async () => {
    const status = directMessage(OPERATOR, 'status?', NOW);
    aflow.holdAnswers = true;
    // The watch limit is zero here, so each watch gives up at once.
    expect((await send(status)).outcome).toBe('started');
    aflow.answerHeld();
    expect(
      (await send(directMessage(OPERATOR, 'go on', NOW, { threadTs: status.ts }))).outcome,
    ).toBe('continued');
    expect(threadOf(status).status).toBe('waiting');

    const early = await send(directMessage(OPERATOR, 'and?', NOW, { threadTs: status.ts }));
    const again = await send(directMessage(OPERATOR, 'and?', NOW, { threadTs: status.ts }));

    expect([early.outcome, again.outcome]).toEqual(['busy', 'busy']);
    expect(aflow.resumes).toHaveLength(1);
    expect(aflow.refusals).toEqual([]);
    expect(slack.posts.map((post) => post.text)).not.toContain(MOVED_ON);
    expect(slack.posts.at(-1)?.text).toBe(STILL_ANSWERING);

    // Once the Helmsman answers, the next reply resumes the new pause.
    aflow.answerHeld();
    expect(
      (await send(directMessage(OPERATOR, 'thanks', NOW, { threadTs: status.ts }))).outcome,
    ).toBe('continued');
    expect(aflow.resumes).toHaveLength(2);
  });

  it('starts one session when two messages for one new thread arrive together', async () => {
    const status = directMessage(OPERATOR, 'status?', NOW);
    const reply = directMessage(OPERATOR, 'and the deploy?', NOW, { threadTs: status.ts });

    const [first, second] = await Promise.all([
      answerInbound(status, deps()),
      answerInbound(reply, deps()),
    ]);
    if ('watching' in first) await first.watching;

    expect(first.outcome).toBe('started');
    expect(second.outcome).toBe('busy');
    expect(aflow.starts).toHaveLength(1);
    expect(aflow.sessions.size).toBe(1);
    expect(slack.posts.map((post) => post.text)).toContain(STILL_ANSWERING);
  });

  it('keeps watching when the notice that it waits at Aflow fails to post', async () => {
    const status = directMessage(OPERATOR, 'status?', NOW);
    const post = slack.postMessage;
    slack.postMessage = (channel, text, options) =>
      text === WAITS_AT_AFLOW
        ? Promise.reject(new Error('Slack is down'))
        : post(channel, text, options);
    aflow.holdAnswers = true;
    let polls = 0;
    const patient = new Conversations({
      store,
      slack,
      api: deps().api,
      aflowUserId: OWNER,
      now: () => NOW,
      pollMs: 0,
      watchLimitMs: 60 * MINUTE,
      sleep: () => {
        polls += 1;
        const [session] = [...aflow.sessions.values()];
        if (polls === 1) aflow.pauseAtAflow(session?.id ?? '');
        if (polls === 2) aflow.answerHeld();
        return Promise.resolve();
      },
    });

    const started = await answerInbound(status, { ...deps(), conversations: patient });
    const watched: WatchOutcome | undefined =
      'watching' in started ? await started.watching : undefined;

    expect(watched).toBe('answered');
    expect(slack.posts.at(-1)?.text).toBe('The Helmsman answers: status?');
    aflow.holdAnswers = false;
    expect(
      (await send(directMessage(OPERATOR, 'go on', NOW, { threadTs: status.ts }))).outcome,
    ).toBe('continued');
  });

  it('leaves the thread open to a reply when the watch fails', async () => {
    const status = directMessage(OPERATOR, 'status?', NOW);
    const api = deps().api;
    let reads = 0;
    const failing = new Conversations({
      store,
      slack,
      api: {
        ...api,
        latestEvents: (spaceId, sessionId) =>
          (reads += 1) === 1
            ? Promise.reject(new Error('the watch broke'))
            : api.latestEvents(spaceId, sessionId),
      },
      aflowUserId: OWNER,
      now: () => NOW,
    });
    aflow.holdAnswers = true;

    const started = await answerInbound(status, { ...deps(), conversations: failing });
    if ('watching' in started) await expect(started.watching).rejects.toThrow('the watch broke');
    expect(threadOf(status).status).toBe('waiting');

    aflow.holdAnswers = false;
    aflow.answerHeld();
    expect(
      (await send(directMessage(OPERATOR, 'go on', NOW, { threadTs: status.ts }))).outcome,
    ).toBe('continued');
  });
});

describe('two replies that arrive together on a waiting thread', () => {
  it('resumes the pause with one, and tells the other the Helmsman is still answering', async () => {
    const status = directMessage(OPERATOR, 'status?', NOW);
    await send(status);
    const [session] = [...aflow.sessions.values()];
    const pausedAt = session?.pausedStep;

    const [first, second] = await Promise.all([
      answerInbound(directMessage(OPERATOR, 'go on', NOW, { threadTs: status.ts }), deps()),
      answerInbound(
        directMessage(OPERATOR, 'and the deploy?', NOW, { threadTs: status.ts }),
        deps(),
      ),
    ]);
    if ('watching' in first) await first.watching;

    expect([first.outcome, second.outcome]).toEqual(['continued', 'busy']);
    expect(aflow.resumes).toHaveLength(1);
    expect(aflow.resumes[0]?.body).toEqual({
      stepExecutionId: pausedAt,
      input: { input: 'go on' },
    });
    expect(aflow.refusals).toEqual([]);
    const texts = slack.posts.map((post) => post.text);
    expect(texts).toContain(STILL_ANSWERING);
    expect(texts).not.toContain(MOVED_ON);
    expect(texts.at(-1)).toBe('The Helmsman answers: go on');

    // The refused reply can be sent again once the answer is here.
    expect(
      (
        await send(
          directMessage(OPERATOR, 'and the deploy?', NOW, {
            threadTs: status.ts,
            eventId: 'Ev-deploy-again',
          }),
        )
      ).outcome,
    ).toBe('continued');
    expect(aflow.resumes).toHaveLength(2);
  });
});

describe('a resume whose outcome is unknown', () => {
  const TIMEOUT = 'The request timed out after it left.';

  /** An API whose resume reaches Aflow, and whose answer never comes back. */
  function timingOutApi() {
    const api = deps().api;
    return {
      ...api,
      resumeConversation: async (...args: Parameters<typeof api.resumeConversation>) => {
        await api.resumeConversation(...args);
        return {
          ok: false as const,
          status: 0,
          error: 'Timeout',
          message: TIMEOUT,
          retryable: true,
          outcomeUnknown: true,
        };
      },
    };
  }

  const answers = () =>
    slack.posts.filter((post) => post.text === 'The Helmsman answers: go on').length;

  it('says it may have been sent, and relays the answer once when it comes', async () => {
    const status = directMessage(OPERATOR, 'status?', NOW);
    await send(status);
    aflow.holdAnswers = true;
    let polls = 0;
    const timingOut = new Conversations({
      store,
      slack,
      api: timingOutApi(),
      aflowUserId: OWNER,
      now: () => NOW,
      pollMs: 0,
      watchLimitMs: 60 * MINUTE,
      sleep: () => {
        if ((polls += 1) === 2) aflow.answerHeld();
        return Promise.resolve();
      },
    });

    const reply = await answerInbound(
      directMessage(OPERATOR, 'go on', NOW, { threadTs: status.ts }),
      { ...deps(), conversations: timingOut },
    );
    const watched = 'watching' in reply ? await reply.watching : undefined;

    expect(reply.outcome).toBe('outcome_unknown');
    expect(watched).toBe('answered');
    expect(slack.posts.map((post) => post.text)).toContain(
      `${MAYBE_SENT} ${TIMEOUT} ${CHECK_AT_AFLOW}`,
    );
    expect(answers()).toBe(1);
    expect(slack.posts.at(-1)?.text).toBe('The Helmsman answers: go on');

    // A restart finds nothing left to post, and the next reply resumes the new pause.
    await Promise.all(newConversations().resumeWatching());
    expect(answers()).toBe(1);
    aflow.holdAnswers = false;
    expect(
      (await send(directMessage(OPERATOR, 'thanks', NOW, { threadTs: status.ts }))).outcome,
    ).toBe('continued');
    expect(aflow.resumes).toHaveLength(2);
    expect(aflow.refusals).toEqual([]);
  });

  it('leaves a record a restarted watch picks up, and the answer is posted once', async () => {
    const status = directMessage(OPERATOR, 'status?', NOW);
    await send(status);
    aflow.holdAnswers = true;
    // This app's watch never wakes again, as one whose process stopped.
    const stopped = new Conversations({
      store,
      slack,
      api: timingOutApi(),
      aflowUserId: OWNER,
      now: () => NOW,
      sleep: () => new Promise<void>(() => undefined),
      watchLimitMs: 60 * MINUTE,
    });
    const reply = await answerInbound(
      directMessage(OPERATOR, 'go on', NOW, { threadTs: status.ts }),
      { ...deps(), conversations: stopped },
    );
    expect(reply.outcome).toBe('outcome_unknown');
    expect(store.threadAt(status.channel, status.ts)?.status).toBe('answering');

    // A reply before the answer is refused, and nothing resumes the old pause.
    const early = await send(directMessage(OPERATOR, 'and?', NOW, { threadTs: status.ts }));
    expect(early.outcome).toBe('busy');
    expect(aflow.resumes).toHaveLength(1);

    aflow.answerHeld();
    store = ChannelStore.open(storePath, NOW);
    await Promise.all(newConversations().resumeWatching());
    await Promise.all(newConversations().resumeWatching());

    expect(answers()).toBe(1);
    expect(store.threadAt(status.channel, status.ts)?.status).toBe('waiting');
  });
});

describe('a waiting thread whose session ended at Aflow', () => {
  async function waitingThread() {
    const status = directMessage(OPERATOR, 'status?', NOW);
    await send(status);
    const [session] = [...aflow.sessions.values()];
    if (session === undefined) throw new Error('no session');
    return { status, session };
  }

  it('says the conversation ended when the resume finds it ended, and every later reply says so', async () => {
    const { status, session } = await waitingThread();
    aflow.endSession(session.id, 'SessionCancelled');

    const reply = await send(directMessage(OPERATOR, 'go on', NOW, { threadTs: status.ts }));
    const later = await send(directMessage(OPERATOR, 'hello?', NOW, { threadTs: status.ts }));

    expect([reply.outcome, later.outcome]).toEqual(['ended', 'ended']);
    expect(store.threadAt(status.channel, status.ts)?.status).toBe('ended');
    expect(slack.posts.slice(-2).map((post) => post.text)).toEqual([
      CONVERSATION_ENDED,
      CONVERSATION_ENDED,
    ]);
    expect(slack.posts.map((post) => post.text)).not.toContain(STILL_ANSWERING);
    expect(slack.posts.map((post) => post.text)).not.toContain(MOVED_ON);
    expect(aflow.resumes).toHaveLength(1);
    expect(aflow.starts).toHaveLength(1);
  });

  it('says the conversation ended when the thread reads the pause from the session', async () => {
    const { status, session } = await waitingThread();
    const thread = store.threadAt(status.channel, status.ts);
    if (thread === undefined) throw new Error('no thread');
    // A watch that gave up leaves the thread waiting with no pause it holds.
    store.updateThread(thread, { pausedStepExecutionId: null }, NOW);
    aflow.endSession(session.id, 'SessionCompleted');

    const reply = await send(directMessage(OPERATOR, 'go on', NOW, { threadTs: status.ts }));

    expect(reply.outcome).toBe('ended');
    expect(slack.posts.at(-1)?.text).toBe(CONVERSATION_ENDED);
    expect(aflow.resumes).toEqual([]);
    expect(store.threadAt(status.channel, status.ts)?.status).toBe('ended');
  });
});

describe('a pause resumed outside this thread', () => {
  it('gets the moved-on notice once, and later replies wait for the answer', async () => {
    const status = directMessage(OPERATOR, 'status?', NOW);
    await send(status);
    const [session] = [...aflow.sessions.values()];
    aflow.holdAnswers = true;
    aflow.resumeAtAflow(session?.id ?? '');

    const first = await send(directMessage(OPERATOR, 'go on', NOW, { threadTs: status.ts }));
    const second = await send(directMessage(OPERATOR, 'go on?', NOW, { threadTs: status.ts }));
    const third = await send(directMessage(OPERATOR, 'and?', NOW, { threadTs: status.ts }));

    expect([first.outcome, second.outcome, third.outcome]).toEqual(['refused', 'busy', 'busy']);
    expect(slack.posts.filter((post) => post.text === MOVED_ON)).toHaveLength(1);
    expect(slack.posts.at(-1)?.text).toBe(STILL_ANSWERING);
    expect(aflow.resumes).toHaveLength(1);

    // Once the Helmsman answers at Aflow, the next reply resumes the new pause.
    aflow.holdAnswers = false;
    aflow.answerHeld();
    expect(
      (await send(directMessage(OPERATOR, 'thanks', NOW, { threadTs: status.ts }))).outcome,
    ).toBe('continued');
  });
});

describe('an answer Slack refuses to post', () => {
  function refuseAnswers(errors: SlackApiError[]): void {
    const post = slack.postMessage;
    slack.postMessage = (channel, text, options) => {
      const error = text.startsWith('The Helmsman answers') ? errors.shift() : undefined;
      return error === undefined ? post(channel, text, options) : Promise.reject(error);
    };
  }

  it('tells the thread the answer was not posted when Slack refused it outright', async () => {
    refuseAnswers([new SlackApiError('chat.postMessage', 'msg_too_long', false)]);
    const status = directMessage(OPERATOR, 'status?', NOW);

    const started = await answerInbound(status, deps());
    const watched = 'watching' in started ? await started.watching : undefined;

    expect(watched).toBe('answered');
    expect(slack.posts.map((post) => post.text)).toEqual([ANSWER_NOT_POSTED]);
    expect(slack.posts[0]?.threadTs).toBe(status.ts);
    // The pause stays open, so a reply continues the conversation.
    expect(
      (await send(directMessage(OPERATOR, 'go on', NOW, { threadTs: status.ts }))).outcome,
    ).toBe('continued');
  });

  it('posts the answer once more when Slack named the refusal retryable', async () => {
    refuseAnswers([new SlackApiError('chat.postMessage', 'ratelimited', true)]);

    await send(directMessage(OPERATOR, 'status?', NOW));

    expect(slack.posts.map((post) => post.text)).toEqual(['The Helmsman answers: status?']);
  });

  it('tells the thread when the second post is refused too', async () => {
    refuseAnswers([
      new SlackApiError('chat.postMessage', 'ratelimited', true),
      new SlackApiError('chat.postMessage', 'ratelimited', true),
    ]);

    await send(directMessage(OPERATOR, 'status?', NOW));

    expect(slack.posts.map((post) => post.text)).toEqual([ANSWER_NOT_POSTED]);
  });

  it('posts nothing again when the post may have landed', async () => {
    refuseAnswers([new SlackApiError('chat.postMessage', 'request_timeout', true, true)]);

    const started = await answerInbound(directMessage(OPERATOR, 'status?', NOW), deps());

    if ('watching' in started) await expect(started.watching).rejects.toThrow('request_timeout');
    expect(slack.posts).toEqual([]);
  });
});

describe('a relayed answer', () => {
  const NOTE = '… The full answer is in the conversation at Aflow.';

  it('is posted whole when it fits Slack’s 40,000 characters once escaped', () => {
    expect(relayed('a < b & c')).toBe('a &lt; b &amp; c');
    expect(relayed('&'.repeat(8_000))).toBe('&amp;'.repeat(8_000));
  });

  it('is cut to fit once escaped, between whole escapes, even when dense in `&`', () => {
    const text = relayed('&'.repeat(30_000));

    expect(text.length).toBeLessThanOrEqual(40_000);
    expect(text.endsWith(NOTE)).toBe(true);
    expect(text.slice(0, -NOTE.length)).toMatch(/^(&amp;)+$/);
  });
});

describe('a message held back past the late threshold', () => {
  const late = late2;

  it('is not sent: the app asks whether to run it', async () => {
    const message = late();

    expect((await send(message)).outcome).toBe('held_late');

    expect(aflow.starts).toEqual([]);
    const question = slack.posts.at(-1);
    expect(question?.text).toBe(LATE_QUESTION);
    expect(question?.threadTs).toBe(message.ts);
    expect(buttonsOf(question?.blocks)).toEqual([LATE_RUN_ACTION, LATE_DISCARD_ACTION]);
    const data = JSON.parse(readFileSync(storePath, 'utf8')) as {
      inbound: Array<{ eventId: string; outcome: string; ageMs: number }>;
    };
    const record = data.inbound.find((entry) => entry.eventId === message.eventId);
    expect(record?.outcome).toBe('held_late');
    expect(record?.ageMs).toBeGreaterThan(10 * MINUTE);
  });

  it('runs on **Run it now**, and the Helmsman reads that it is old', async () => {
    const message = late();
    await send(message);
    const promptTs = `1700000000.00${String(slack.posts.length)}`;

    expect((await tapLate(promptTs, LATE_RUN_ACTION)).outcome).toBe('ran_late');

    expect(aflow.starts).toHaveLength(1);
    const sent = (aflow.starts[0]?.body['input'] as { input: string }).input;
    expect(sent.startsWith('restart the deploy')).toBe(true);
    expect(sent).toContain('Sent from Slack at 2026-11-01T08:49:00.000Z');
    expect(sent).toContain('chose to run it 11 minutes after sending it');
    expect(slack.updates.at(-1)?.text).toContain('Run at the request of');
    expect(slack.posts.at(-1)?.threadTs).toBe(message.ts);
    expect(slack.posts.at(-1)?.text.startsWith('The Helmsman answers: restart the deploy')).toBe(
      true,
    );

    expect((await tapLate(promptTs, LATE_RUN_ACTION)).outcome).toBe('already_decided');
    expect(slack.posts.at(-1)?.text).toBe(LATE_ALREADY_DECIDED);
    expect(aflow.starts).toHaveLength(1);
  });

  it('sends nothing on **Discard**, and keeps none of its text', async () => {
    const message = late();
    await send(message);
    const promptTs = `1700000000.00${String(slack.posts.length)}`;

    expect((await tapLate(promptTs, LATE_DISCARD_ACTION)).outcome).toBe('discarded');

    expect(aflow.starts).toEqual([]);
    expect(readFileSync(storePath, 'utf8')).not.toContain('restart the deploy');
    expect(slack.updates.at(-1)?.text).toContain('Discarded by');
  });

  it('runs a message just inside the threshold at once', async () => {
    const message = directMessage(OPERATOR, 'status?', NOW, { ageMs: 9 * MINUTE });

    expect((await send(message)).outcome).toBe('started');
  });
});

describe('a message from anyone but the linked operator', () => {
  it('is refused: no conversation starts, and nothing of it is stored', async () => {
    const secret = 'approve the production push';
    const result = await send(directMessage('U-STRANGER', secret, NOW));

    expect(result.outcome).toBe('stranger');
    expect(aflow.starts).toEqual([]);
    expect(aflow.resumes).toEqual([]);
    expect(slack.posts).toEqual([{ channel: 'D-U-STRANGER', text: STRANGER_REPLY }]);
    const stored = readFileSync(storePath, 'utf8');
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('U-STRANGER');
  });

  it('is refused in the thread of the operator’s conversation too', async () => {
    const status = directMessage(OPERATOR, 'status?', NOW);
    await send(status);

    const result = await send(
      directMessage('U-STRANGER', 'cancel everything', NOW, { threadTs: status.ts }),
    );

    expect(result.outcome).toBe('stranger');
    expect(aflow.resumes).toEqual([]);
  });

  it('cannot run a late message from its question', async () => {
    await send(late2());
    const promptTs = `1700000000.00${String(slack.posts.length)}`;
    const result = await answerTap(
      {
        slackUserId: 'U-STRANGER',
        channel: `D-${OPERATOR}`,
        messageTs: promptTs,
        actionId: LATE_RUN_ACTION,
      },
      deps(),
    );

    expect(typeof result === 'string' ? result : result.outcome).toBe('ignored');
    expect(aflow.starts).toEqual([]);
  });
});

function late2() {
  return directMessage(OPERATOR, 'restart the deploy', NOW, { ageMs: 11 * MINUTE });
}
