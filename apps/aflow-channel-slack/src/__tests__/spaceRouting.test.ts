/**
 * A new direct message picks its space. One that names a space goes there, and
 * one that names none goes to the channel's current space: the space last
 * named, or the last space whose answer came. The home space serves only a
 * channel with neither. `spaces` lists the spaces, and a reply in a thread
 * names none. The app's real API client talks to a fake Aflow.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAflowApi, type AflowApi } from '../aflowApi.js';
import type { ChannelSlackConfig } from '../config.js';
import { Conversations, LATE_RUN_ACTION } from '../conversation.js';
import { answerInbound, answerTap, type InboundResult } from '../inbound.js';
import { ChannelMessageSendHandler } from '../sendHandler.js';
import { ADDRESS_HINT, SPACES_HEADING, UNKNOWN_SPACE, spaceSetText } from '../spaceAddress.js';
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
  BACK_OFFICE,
  NIGHT_DESK,
  NIGHT_DESK_NAME,
  directMessage,
  fakeAflow,
  type FakeAflow,
} from './conversationFixtures.js';

const NOW = new Date('2026-11-01T09:00:00.000Z');
const MINUTE = 60_000;
const NIGHT_DESK_PREFIX = `[${NIGHT_DESK_NAME}] `;
const CHANNEL = `D-${OPERATOR}`;

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
let storePath: string;
let store: ChannelStore;
let slack: RecordingSlack;
let aflow: FakeAflow;
let api: AflowApi;
let handler: ChannelMessageSendHandler;
let conversations: Conversations;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'channel-slack-spaces-'));
  storePath = join(dir, 'store.json');
  store = ChannelStore.open(storePath, NOW);
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

const deps = () => ({
  store,
  slack,
  api,
  config,
  conversations,
  log: { warn: () => undefined },
  now: () => NOW,
});

/** Answers a message, and waits for the watch it started to post. */
async function send(message: ReturnType<typeof directMessage>): Promise<InboundResult> {
  const result = await answerInbound(message, deps());
  if ('watching' in result) await result.watching;
  return result;
}

/** A new direct message, a second after the one before it. */
let age = 0;
function dm(text: string, options: { ageMs?: number; threadTs?: string } = {}) {
  age += 1_000;
  return directMessage(OPERATOR, text, NOW, { ageMs: 60_000 - age, ...options });
}

function lastStart() {
  const start = aflow.starts.at(-1);
  return {
    spaceId: start?.spaceId,
    input: (start?.body['input'] as { input?: string } | undefined)?.input,
  };
}

describe('a new direct message that names a space', () => {
  it('goes to the space its `#slug` names, and the answer names that space', async () => {
    const message = dm('#night-desk what runs now?');

    expect((await send(message)).outcome).toBe('started');

    expect(lastStart()).toEqual({ spaceId: NIGHT_DESK, input: 'what runs now?' });
    expect(slack.posts.at(-1)).toEqual({
      channel: CHANNEL,
      text: `${NIGHT_DESK_PREFIX}The Helmsman answers: what runs now?`,
      threadTs: message.ts,
    });
    expect(store.threadAt(CHANNEL, message.ts)?.spaceId).toBe(NIGHT_DESK);
  });

  it('goes to the space its `@slug` names', async () => {
    await send(dm('@night-desk status?'));

    expect(lastStart()).toEqual({ spaceId: NIGHT_DESK, input: 'status?' });
  });

  it('goes to the space its name and a colon name, whatever the case', async () => {
    await send(dm('night desk: status?'));

    expect(lastStart()).toEqual({ spaceId: NIGHT_DESK, input: 'status?' });
    expect(slack.posts.at(-1)?.text).toBe(`${NIGHT_DESK_PREFIX}The Helmsman answers: status?`);
  });

  it('makes that space current when it holds no message, and starts nothing', async () => {
    const message = dm('#night-desk');

    expect((await send(message)).outcome).toBe('space_set');

    expect(aflow.starts).toEqual([]);
    expect(store.currentSpace(CHANNEL)).toBe(NIGHT_DESK);
    expect(slack.posts).toEqual([
      {
        channel: CHANNEL,
        text: `${NIGHT_DESK_PREFIX}${spaceSetText({ id: NIGHT_DESK, name: NIGHT_DESK_NAME, slug: 'night-desk', reachable: true })}`,
        threadTs: message.ts,
      },
    ]);
  });

  it('names the space after the late question, once the operator runs it', async () => {
    const message = dm('#night-desk restart the deploy', { ageMs: 11 * MINUTE });
    expect((await send(message)).outcome).toBe('held_late');
    const promptTs = `1700000000.00${String(slack.posts.length)}`;

    const tapped = await answerTap(
      { slackUserId: OPERATOR, channel: CHANNEL, messageTs: promptTs, actionId: LATE_RUN_ACTION },
      deps(),
    );
    if (typeof tapped === 'string') throw new Error(`a card answered the tap: ${tapped}`);
    await tapped.watching;

    const { spaceId, input } = lastStart();
    expect(spaceId).toBe(NIGHT_DESK);
    expect(input?.startsWith('restart the deploy\n\n(Sent from Slack at')).toBe(true);
  });
});

describe('a space the operator cannot reach', () => {
  const unknown = `${UNKNOWN_SPACE}\n• Trading Joe \`#trading-joe\` (current)\n• Night Desk \`#night-desk\`\n${ADDRESS_HINT}`;

  it('gets one fixed reply that lists the spaces they reach, and nothing is sent', async () => {
    const message = dm('#nowhere status?');

    expect((await send(message)).outcome).toBe('space_unknown');

    expect(aflow.starts).toEqual([]);
    expect(slack.posts).toEqual([{ channel: CHANNEL, text: unknown, threadTs: message.ts }]);
    expect(store.currentSpace(CHANNEL)).toBeUndefined();
  });

  it('gets the same reply for a space they see and are no member of', async () => {
    await send(dm('#back-office status?'));
    await send(dm('Back Office: status?'));

    expect(aflow.starts).toEqual([]);
    expect(slack.posts.map((post) => post.text)).toEqual([unknown, unknown]);
  });
});

describe('a new direct message that names no space', () => {
  it('goes to the home space while the channel has no current space', async () => {
    await send(dm('status?'));

    expect(lastStart()).toEqual({ spaceId: SPACE, input: 'status?' });
    expect(slack.posts.at(-1)?.text).toBe(`${PREFIX}The Helmsman answers: status?`);
  });

  it('goes to the space last named in the channel, which the store keeps', async () => {
    await send(dm('#night-desk status?'));
    await send(dm('and the queue?'));

    expect(lastStart()).toEqual({ spaceId: NIGHT_DESK, input: 'and the queue?' });
    expect(ChannelStore.open(storePath, NOW).currentSpace(CHANNEL)).toBe(NIGHT_DESK);

    await send(dm('#trading-joe status?'));
    await send(dm('and the orders?'));

    expect(lastStart()).toEqual({ spaceId: SPACE, input: 'and the orders?' });
  });

  it('goes to the space whose answer last came in the channel', async () => {
    await send(dm('#trading-joe status?'));
    const { result } = await sendStep(
      handler,
      { text: 'The night batch failed.' },
      {
        spaceId: NIGHT_DESK,
      },
    );
    expect(result.status).toBe('SUCCEEDED');
    const postedTs = `1700000000.00${String(slack.posts.length)}`;
    expect(store.currentSpace(CHANNEL)).toBe(SPACE);

    await send(dm('why?', { threadTs: postedTs }));
    expect(slack.posts.at(-1)?.text.startsWith(NIGHT_DESK_PREFIX)).toBe(true);
    expect(store.currentSpace(CHANNEL)).toBe(NIGHT_DESK);

    await send(dm('and now?'));
    expect(lastStart()).toEqual({ spaceId: NIGHT_DESK, input: 'and now?' });
  });

  it('goes to the home space when the current space is one the operator no longer reaches', async () => {
    store.setCurrentSpace(CHANNEL, BACK_OFFICE, NOW);

    await send(dm('status?'));

    expect(lastStart().spaceId).toBe(SPACE);
  });
});

describe('`spaces`', () => {
  it('lists the spaces the operator reaches with their slugs, the home space current at first', async () => {
    const message = dm('spaces');

    expect((await send(message)).outcome).toBe('spaces_listed');

    expect(aflow.starts).toEqual([]);
    expect(slack.posts).toEqual([
      {
        channel: CHANNEL,
        text: `${SPACES_HEADING}\n• Trading Joe \`#trading-joe\` (current)\n• Night Desk \`#night-desk\`\n${ADDRESS_HINT}`,
        threadTs: message.ts,
      },
    ]);
  });

  it('marks the current space once a message has named one', async () => {
    await send(dm('#night-desk'));
    await send(dm('Spaces'));

    expect(slack.posts.at(-1)?.text).toBe(
      `${SPACES_HEADING}\n• Trading Joe \`#trading-joe\`\n• Night Desk \`#night-desk\` (current)\n${ADDRESS_HINT}`,
    );
  });

  it('is answered at once however late it arrives, since it runs nothing', async () => {
    expect((await send(dm('spaces', { ageMs: 11 * MINUTE }))).outcome).toBe('spaces_listed');
  });
});

describe('a reply in a thread', () => {
  it('ignores a space it names, and continues the thread’s conversation', async () => {
    const status = dm('status?');
    await send(status);
    const [session] = [...aflow.sessions.values()];

    expect((await send(dm('#night-desk restart it', { threadTs: status.ts }))).outcome).toBe(
      'continued',
    );

    expect(aflow.starts).toHaveLength(1);
    expect(aflow.resumes.at(-1)).toMatchObject({
      sessionId: session?.id,
      body: { input: { input: '#night-desk restart it' } },
    });
    expect(slack.posts.at(-1)?.text).toBe(`${PREFIX}The Helmsman answers: #night-desk restart it`);
    expect(store.currentSpace(CHANNEL)).toBe(SPACE);
  });

  it('under a run’s message stays in that run’s space, whatever space it names', async () => {
    const { result } = await sendStep(
      handler,
      { text: 'The batch failed.' },
      { spaceId: NIGHT_DESK },
    );
    expect(result.status).toBe('SUCCEEDED');
    const postedTs = `1700000000.00${String(slack.posts.length)}`;

    await send(dm('#trading-joe why?', { threadTs: postedTs }));

    expect(lastStart().spaceId).toBe(NIGHT_DESK);
    expect(lastStart().input?.startsWith('#trading-joe why?')).toBe(true);
  });

  it('sends `spaces` to the Helmsman as text', async () => {
    const status = dm('status?');
    await send(status);

    await send(dm('spaces', { threadTs: status.ts }));

    expect(aflow.resumes.at(-1)?.body).toMatchObject({ input: { input: 'spaces' } });
    expect(slack.posts.at(-1)?.text).toBe(`${PREFIX}The Helmsman answers: spaces`);
  });

  it('never lists the spaces or refuses an unknown one', async () => {
    const status = dm('status?');
    await send(status);

    await send(dm('#nowhere now', { threadTs: status.ts }));

    expect(slack.posts.some((post) => post.text.includes(UNKNOWN_SPACE))).toBe(false);
    expect(aflow.resumes.at(-1)?.body).toMatchObject({ input: { input: '#nowhere now' } });
    const data = JSON.parse(readFileSync(storePath, 'utf8')) as {
      inbound: Array<{ outcome: string }>;
    };
    expect(data.inbound.map((entry) => entry.outcome)).toEqual(['started', 'continued']);
  });
});
