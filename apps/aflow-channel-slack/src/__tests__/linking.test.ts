/**
 * Plan 327 D5 and §6: one code links one Slack user, and a stranger gets one
 * fixed reply, with no text stored.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChannelSlackConfig } from '../config.js';
import {
  LINKED_OPERATOR_REPLY,
  LINKED_REPLY,
  STRANGER_REPLY,
  answerDirectMessage,
} from '../linking.js';
import { directMessageOf } from '../socketMode.js';
import type { SlackClient } from '../slack.js';
import { ChannelStore } from '../store.js';
// The setup that prints the code and the app that reads it must hash it alike.
import { linkCodeSha256, newLinkCode } from '../../scripts/setup.mjs';

const NOW = new Date('2026-11-01T09:00:00.000Z');
const CODE = 'K7QM-2XRD';

function config(overrides: Partial<ChannelSlackConfig> = {}): ChannelSlackConfig {
  return {
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_APP_TOKEN: 'xapp-test',
    AFLOW_API_URL: 'http://localhost:3000',
    AFLOW_API_KEY: 'phx_test',
    AFLOW_TENANT_ID: 'tenant-1',
    AFLOW_USER_ID: 'owner-1',
    CHANNEL_REDIS_URL: 'redis://127.0.0.1:6379',
    CHANNEL_REDIS_PASSWORD: 'c'.repeat(64),
    CHANNEL_SLACK_LINK_CODE_SHA256: linkCodeSha256(CODE) as string,
    CHANNEL_SLACK_LINK_CODE_EXPIRES_AT: new Date(NOW.getTime() + 60_000).toISOString(),
    ...overrides,
  };
}

let dir: string;
let storePath: string;
let store: ChannelStore;
let replies: Array<{ channel: string; text: string }>;
const slack: SlackClient = {
  openDirectMessage: (userId) => Promise.resolve(`D-${userId}`),
  postMessage: (channel, text) => {
    replies.push({ channel, text });
    return Promise.resolve({ channel, ts: '1.0' });
  },
  openSocketModeUrl: () => Promise.resolve('wss://example.invalid'),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'channel-slack-link-'));
  storePath = join(dir, 'channel-slack.store.json');
  store = ChannelStore.open(storePath);
  replies = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function dm(user: string, text: string) {
  return { slackUserId: user, slackTeamId: 'T1', channel: `D-${user}`, text };
}

describe('linking', () => {
  it('links the Slack user who sends the code to the key’s user', async () => {
    const outcome = await answerDirectMessage(dm('U-OPERATOR', 'k7qm 2xrd'), {
      store,
      config: config(),
      slack,
      now: () => NOW,
    });

    expect(outcome).toBe('linked');
    expect(store.link()).toMatchObject({
      slackUserId: 'U-OPERATOR',
      aflowUserId: 'owner-1',
      tenantId: 'tenant-1',
    });
    expect(replies).toEqual([{ channel: 'D-U-OPERATOR', text: LINKED_REPLY }]);
  });

  it('serves only that user afterwards: the same code cannot link a second one', async () => {
    const deps = { store, config: config(), slack, now: () => NOW };
    await answerDirectMessage(dm('U-OPERATOR', CODE), deps);
    const second = await answerDirectMessage(dm('U-STRANGER', CODE), deps);

    expect(second).toBe('stranger');
    expect(store.link()?.slackUserId).toBe('U-OPERATOR');
  });

  it('refuses an expired code', async () => {
    const outcome = await answerDirectMessage(dm('U-OPERATOR', CODE), {
      store,
      config: config({ CHANNEL_SLACK_LINK_CODE_EXPIRES_AT: NOW.toISOString() }),
      slack,
      now: () => NOW,
    });

    expect(outcome).toBe('stranger');
    expect(store.link()).toBeNull();
  });

  it('gives a stranger one fixed reply and stores none of their text', async () => {
    const secret = 'please approve the production push';
    const outcome = await answerDirectMessage(dm('U-STRANGER', secret), {
      store,
      config: config(),
      slack,
      now: () => NOW,
    });

    expect(outcome).toBe('stranger');
    expect(replies).toEqual([{ channel: 'D-U-STRANGER', text: STRANGER_REPLY }]);
    expect(readFileSync(storePath, 'utf8')).not.toContain(secret);
  });

  it('tells the linked operator that answering from Slack is not here yet', async () => {
    const deps = { store, config: config(), slack, now: () => NOW };
    await answerDirectMessage(dm('U-OPERATOR', CODE), deps);
    const outcome = await answerDirectMessage(dm('U-OPERATOR', 'status?'), deps);

    expect(outcome).toBe('operator');
    expect(replies.at(-1)?.text).toBe(LINKED_OPERATOR_REPLY);
  });

  it('prints codes the app reads back, whatever the case or spacing typed', () => {
    const code = newLinkCode() as string;
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(linkCodeSha256(code.toLowerCase().replace('-', ' '))).toBe(linkCodeSha256(code));
  });
});

describe('the store', () => {
  it('lives at mode 0600 and records its migrations', () => {
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
    const data = JSON.parse(readFileSync(storePath, 'utf8')) as { migrations: string[] };
    expect(data.migrations).toEqual(['0001-link-and-sent']);
  });

  it('reopens what it wrote', () => {
    store.linkWithCode('b'.repeat(64), {
      slackUserId: 'U-OPERATOR',
      aflowUserId: 'owner-1',
      tenantId: 'tenant-1',
      linkedAt: NOW.toISOString(),
    });
    expect(ChannelStore.open(storePath).link()?.slackUserId).toBe('U-OPERATOR');
  });
});

describe('Socket Mode envelopes', () => {
  const envelope = (event: Record<string, unknown>) => ({
    type: 'events_api',
    envelope_id: 'e-1',
    payload: { team_id: 'T1', event },
  });

  it('passes an ordinary direct message from a person', () => {
    expect(
      directMessageOf(
        envelope({ type: 'message', channel_type: 'im', user: 'U1', channel: 'D1', text: 'hi' }),
      ),
    ).toEqual({ slackUserId: 'U1', slackTeamId: 'T1', channel: 'D1', text: 'hi' });
  });

  it.each([
    ['the bot’s own reply', { bot_id: 'B1' }],
    ['an edit', { subtype: 'message_changed' }],
    ['a channel message', { channel_type: 'channel' }],
  ])('drops %s', (_case, override) => {
    expect(
      directMessageOf(
        envelope({
          type: 'message',
          channel_type: 'im',
          user: 'U1',
          channel: 'D1',
          text: 'hi',
          ...override,
        }),
      ),
    ).toBeUndefined();
  });
});
