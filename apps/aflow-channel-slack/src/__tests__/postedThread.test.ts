/**
 * A message `channel.message.send` posted owns its thread. A reply under it
 * stays in the run's space: it resumes the Helmsman conversation that sent the
 * message when that session is paused on the operator, and otherwise starts one
 * in that space with the run and the message as context. Every post names the
 * space. The app's real API client talks to a fake Aflow that keeps the routes' rules.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAflowApi, type AflowApi } from '../aflowApi.js';
import type { ChannelSlackConfig } from '../config.js';
import { Conversations, LATE_QUESTION, postedReplyText } from '../conversation.js';
import { answerInbound } from '../inbound.js';
import { STRANGER_REPLY } from '../linking.js';
import { ChannelMessageSendHandler } from '../sendHandler.js';
import { ChannelStore } from '../store.js';
import {
  OPERATOR,
  OWNER,
  PREFIX,
  SPACE,
  linkOperator,
  recordingSlack,
  sendStep,
  type RecordingSlack,
} from './cardFixtures.js';
import {
  NIGHT_DESK,
  NIGHT_DESK_NAME,
  directMessage,
  fakeAflow,
  type FakeAflow,
} from './conversationFixtures.js';

const NOW = new Date('2026-11-01T09:00:00.000Z');
const MINUTE = 60_000;
const NIGHT_DESK_PREFIX = `[${NIGHT_DESK_NAME}] `;

const config: ChannelSlackConfig = {
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_APP_TOKEN: 'xapp-test',
  AFLOW_API_URL: 'http://127.0.0.1:3000',
  AFLOW_API_KEY: 'phx_owner',
  AFLOW_TENANT_ID: 'tenant-1',
  AFLOW_USER_ID: OWNER,
  CHANNEL_REDIS_URL: 'redis://127.0.0.1:6379',
  CHANNEL_REDIS_PASSWORD: 'c'.repeat(64),
  CHANNEL_SLACK_LINK_CODE_SHA256: 'd'.repeat(64),
  CHANNEL_SLACK_LINK_CODE_EXPIRES_AT: new Date(NOW.getTime() + MINUTE).toISOString(),
};

let dir: string;
let store: ChannelStore;
let slack: RecordingSlack;
let aflow: FakeAflow;
let api: AflowApi;
let handler: ChannelMessageSendHandler;
let conversations: Conversations;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'channel-slack-posted-'));
  store = ChannelStore.open(join(dir, 'store.json'), NOW);
  linkOperator(store);
  slack = recordingSlack();
  aflow = fakeAflow();
  api = createAflowApi({
    apiUrl: config.AFLOW_API_URL,
    apiKey: config.AFLOW_API_KEY,
    fetchImpl: aflow.fetch,
  });
  handler = new ChannelMessageSendHandler({ store, slack, api, now: () => NOW });
  conversations = new Conversations({
    store,
    slack,
    api,
    aflowUserId: OWNER,
    now: () => NOW,
    sleep: () => new Promise<void>((done) => setImmediate(done)),
    pollMs: 0,
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Posts `text` from a run, and returns the posted message. */
async function post(text: string, scope: Parameters<typeof sendStep>[2] = {}) {
  const { result } = await sendStep(handler, { text }, scope);
  expect(result.status).toBe('SUCCEEDED');
  const posted = slack.posts.at(-1);
  if (posted === undefined) throw new Error('expected a post');
  return { channel: posted.channel, ts: `1700000000.00${String(slack.posts.length)}` };
}

async function reply(under: { ts: string }, text: string, options: { ageMs?: number } = {}) {
  const result = await answerInbound(
    directMessage(OPERATOR, text, NOW, { threadTs: under.ts, ...options }),
    { store, slack, api, config, conversations, log: { warn: () => undefined }, now: () => NOW },
  );
  const watched = 'watching' in result ? await result.watching : undefined;
  return { outcome: result.outcome, watched };
}

describe('a reply under a message a Helmsman conversation sent', () => {
  it('resumes that session when it is paused on the operator, and the answer names the space', async () => {
    const sessionId = aflow.openSession({ pausedOnInput: true });
    const pausedAt = aflow.sessions.get(sessionId)?.pausedStep;
    const message = await post('Two deploys failed overnight.', { sessionId });

    expect(slack.posts[0]?.text).toBe(`${PREFIX}Two deploys failed overnight.`);
    expect(store.threadAt(message.channel, message.ts)).toMatchObject({
      sessionId,
      spaceId: SPACE,
      status: 'posted',
    });

    const answered = await reply(message, 'retry the first one');

    expect(answered).toEqual({ outcome: 'continued', watched: 'answered' });
    expect(aflow.starts).toEqual([]);
    expect(aflow.resumes).toEqual([
      {
        sessionId,
        body: { stepExecutionId: pausedAt, input: { input: 'retry the first one' } },
      },
    ]);
    expect(slack.posts.at(-1)).toEqual({
      channel: message.channel,
      text: `${PREFIX}The Helmsman answers: retry the first one`,
      threadTs: message.ts,
    });
    expect(store.threadAt(message.channel, message.ts)).toMatchObject({
      sessionId,
      status: 'waiting',
    });
  });

  it('starts a conversation in the space when that session is not paused on the operator', async () => {
    const sessionId = aflow.openSession();
    const message = await post('The nightly report is ready.', { sessionId });

    const answered = await reply(message, 'summarise it');

    expect(answered).toEqual({ outcome: 'started', watched: 'answered' });
    expect(aflow.resumes).toEqual([]);
    expect(aflow.starts).toHaveLength(1);
    expect(aflow.starts[0]?.spaceId).toBe(SPACE);
    const started = store.threadAt(message.channel, message.ts);
    expect(started?.sessionId).not.toBe(sessionId);
    expect(started?.status).toBe('waiting');
  });
});

describe('a reply under a message no Helmsman conversation sent', () => {
  it('starts a conversation in the run’s space, not the home space, with the run and the message', async () => {
    const message = await post('Three invoices are overdue.', {
      runId: 'wr-nightly',
      spaceId: NIGHT_DESK,
    });

    expect(slack.posts[0]?.text).toBe(`${NIGHT_DESK_PREFIX}Three invoices are overdue.`);
    expect(store.threadAt(message.channel, message.ts)).toMatchObject({
      sessionId: null,
      spaceId: NIGHT_DESK,
      runId: 'wr-nightly',
    });

    const answered = await reply(message, 'chase the oldest one');

    expect(answered).toEqual({ outcome: 'started', watched: 'answered' });
    expect(aflow.starts).toHaveLength(1);
    const [start] = aflow.starts;
    expect(start?.spaceId).toBe(NIGHT_DESK);
    const input = (start?.body['input'] as { input: string }).input;
    expect(input.startsWith('chase the oldest one')).toBe(true);
    expect(input).toContain('run wr-nightly');
    expect(input).toContain('Three invoices are overdue.');
    const thread = store.threadAt(message.channel, message.ts);
    if (thread === undefined) throw new Error('expected the thread');
    expect(input).toBe(postedReplyText('chase the oldest one', thread));
    expect(slack.posts.at(-1)?.text.startsWith(`${NIGHT_DESK_PREFIX}The Helmsman answers:`)).toBe(
      true,
    );

    // The thread now continues the conversation it started.
    const next = await reply(message, 'and the second?');
    expect(next).toEqual({ outcome: 'continued', watched: 'answered' });
    expect(aflow.starts).toHaveLength(1);
    expect(aflow.resumes.map((resume) => resume.sessionId)).toEqual([thread.sessionId]);
    expect(slack.posts.at(-1)?.text).toBe(
      `${NIGHT_DESK_PREFIX}The Helmsman answers: and the second?`,
    );
  });

  it.each([
    ['another agent', { target: { kind: 'custom-agent', agentId: randomUUID() } }],
    [
      'a Helmsman another session delegated',
      { parentSessionId: randomUUID(), pausedOnInput: true },
    ],
  ])('starts a conversation for a message %s sent, and resumes nothing', async (_case, opened) => {
    const sessionId = aflow.openSession(opened);
    const message = await post('A step needs a decision.', { sessionId });

    expect(store.threadAt(message.channel, message.ts)?.sessionId).toBeNull();
    expect(await reply(message, 'take the safe option')).toEqual({
      outcome: 'started',
      watched: 'answered',
    });
    expect(aflow.resumes).toEqual([]);
    expect(aflow.starts.map((start) => start.spaceId)).toEqual([SPACE]);
  });

  it('asks about a late reply under the space’s name, and runs it in that space', async () => {
    const message = await post('Three invoices are overdue.', { spaceId: NIGHT_DESK });

    const held = await reply(message, 'chase them', { ageMs: 15 * MINUTE });

    expect(held.outcome).toBe('held_late');
    const question = slack.posts.at(-1);
    expect(question?.text).toBe(`${NIGHT_DESK_PREFIX}${LATE_QUESTION}`);
    expect(JSON.stringify(question?.blocks)).toContain(`${NIGHT_DESK_PREFIX}${LATE_QUESTION}`);
    expect(aflow.starts).toEqual([]);
  });

  it('starts nothing for a stranger’s reply under the message', async () => {
    const message = await post('Three invoices are overdue.', { spaceId: NIGHT_DESK });

    const result = await answerInbound(
      directMessage('U-STRANGER', 'chase them', NOW, { threadTs: message.ts }),
      { store, slack, api, config, conversations, log: { warn: () => undefined }, now: () => NOW },
    );

    expect(result.outcome).toBe('stranger');
    expect(slack.posts.at(-1)?.text).toBe(STRANGER_REPLY);
    expect(aflow.starts).toEqual([]);
    expect(store.threadAt(message.channel, message.ts)?.status).toBe('posted');
  });
});
