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
  CONVERSATION_ENDED,
  Conversations,
  LATE_ALREADY_DECIDED,
  LATE_DISCARD_ACTION,
  LATE_QUESTION,
  LATE_RUN_ACTION,
  MOVED_ON,
  NOT_THE_KEY_OWNER,
  STILL_ANSWERING,
  type ConversationResult,
} from '../conversation.js';
import { answerInbound, answerTap, type InboundResult } from '../inbound.js';
import { CODE_ALREADY_USED_REPLY, STRANGER_REPLY } from '../linking.js';
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
  await answerInbound(directMessage(OPERATOR, CODE, NOW, { eventId: 'Ev-link' }), deps());
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
