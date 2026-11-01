/**
 * Plan 327 D3 and §6: a tap resolves through the route the web app calls, and
 * the card says what was decided and by whom. A second tap is answered already
 * decided from the card's record, and the card keeps its note. Free text approves
 * nothing: "yes" in a card's thread leaves the item open, and the app points to
 * the button.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ActionCenterItem } from '@aflow/schemas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CARD_BUSY,
  CHECK_BEFORE_ANSWERING,
  ITEM_CHANGED,
  NOT_SENT_TRY_AGAIN,
  OUTCOME_UNKNOWN,
  REPLY_CARD_SETTLED,
  REPLY_DECIDES_NOTHING,
  REPLY_AGAIN,
  REPLY_NEEDS_AFLOW,
  TAP_ALREADY_DECIDED,
  TAP_CARD_OUTDATED,
  TAP_NO_CARD,
  TAP_NOT_OFFERED,
  answerCardReply,
  answerCardTap,
} from '../cardActions.js';
import { ChannelMessageSendHandler } from '../sendHandler.js';
import { cardTapOf, directMessageOf } from '../socketMode.js';
import { ChannelStore, type CardRecord } from '../store.js';
import {
  OPERATOR,
  STEP_ORIGIN,
  buttonsOf,
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
let deps: { store: ChannelStore; slack: RecordingSlack; api: FakeApi };

const approval = makeItem();
const question = makeItem({
  id: 'step:ask-1',
  kind: 'human_input',
  origin: { ...STEP_ORIGIN, stepExecutionId: 'ask-1', operationId: 'user.interaction.ask' },
  title: 'Name the release',
  resolutionSchema: { type: 'string' },
});
const planAsk = makeItem({
  id: 'plan-ask:0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  origin: { type: 'plan_ask', nodeId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', revision: 2 },
  title: 'Unblock the migration',
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'channel-slack-tap-'));
  store = ChannelStore.open(join(dir, 'store.json'));
  linkOperator(store);
  slack = recordingSlack();
  api = fakeApi(approval, question, planAsk, writeApproval('medium'));
  deps = { store, slack, api };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Sends `item` as a card, as an agent would, and returns the card the app recorded. */
async function sendCard(item: ActionCenterItem, executionId = 'exec-1'): Promise<CardRecord> {
  const handler = new ChannelMessageSendHandler({ store, slack, api });
  const { result } = await sendStep(
    handler,
    { text: `${item.title} waits on you.`, itemId: item.id },
    { executionId },
  );
  if (result.status !== 'SUCCEEDED') throw new Error(`the card was not sent: ${result.status}`);
  const post = slack.posts.at(-1);
  const card = store.cardAt(post?.channel ?? '', `1700000000.00${String(slack.posts.length)}`);
  if (card === undefined) throw new Error('no card recorded');
  return card;
}

function tap(card: CardRecord, actionId: string, slackUserId = OPERATOR) {
  return answerCardTap({ slackUserId, channel: card.channel, messageTs: card.ts, actionId }, deps);
}

function reply(card: CardRecord, text: string) {
  return answerCardReply(
    { slackUserId: OPERATOR, channel: card.channel, threadTs: card.ts, text },
    deps,
  );
}

describe('a tap on a card', () => {
  it('resolves through the resolve route with the origin as read, and the card says what and by whom', async () => {
    const card = await sendCard(writeApproval('medium'));

    expect(await tap(card, 'approve')).toBe('resolved');

    expect(api.resolves).toEqual([
      {
        itemId: writeApproval('medium').id,
        origin: writeApproval('medium').origin,
        resolution: { kind: 'approve' },
      },
    ]);
    expect(api.items.get(writeApproval('medium').id)?.status).toBe('resolved');
    const [edit] = slack.updates;
    expect(edit?.ts).toBe(card.ts);
    expect(buttonsOf(edit?.blocks)).toEqual([]);
    expect(textOf(edit?.blocks)).toContain(`Approved by <@${OPERATOR}> from Slack.`);
    expect(textOf(edit?.blocks)).toContain('POST api.github.com');
  });

  it('sends a denial as a reject, and the card says denied', async () => {
    const card = await sendCard(approval);

    expect(await tap(card, 'reject')).toBe('resolved');
    expect(api.resolves[0]?.resolution.kind).toBe('reject');
    expect(textOf(slack.updates[0]?.blocks)).toContain(`Denied by <@${OPERATOR}> from Slack.`);
  });

  it('answers a second tap "already decided" from the card, and the card keeps who decided', async () => {
    const card = await sendCard(approval);
    await tap(card, 'approve');
    const decided = `Approved by <@${OPERATOR}> from Slack.`;

    expect(await tap(card, 'reject')).toBe('already_decided');

    expect(api.resolves).toHaveLength(1);
    expect(slack.updates).toHaveLength(1);
    expect(textOf(slack.updates[0]?.blocks)).toContain(decided);
    expect(store.cardAt(card.channel, card.ts)?.outcome?.note).toBe(decided);
    expect(slack.posts.at(-1)).toEqual({
      channel: card.channel,
      text: `${TAP_ALREADY_DECIDED} ${decided}`,
      threadTs: card.ts,
    });
    expect(api.items.get(approval.id)?.resolution).toEqual({ kind: 'approve' });
  });

  it('says "already decided" with the resolve route’s own answer for an item decided at Aflow before the tap', async () => {
    const card = await sendCard(approval);
    api.items.set(approval.id, { ...approval, status: 'resolved' });

    expect(await tap(card, 'reject')).toBe('already_decided');
    expect(api.resolves).toHaveLength(1);
    const edit = slack.updates[0];
    expect(textOf(edit?.blocks)).toContain('Already decided. This tap changed nothing.');
    expect(textOf(edit?.blocks)).toContain('Origin CAS mismatch');
    expect(buttonsOf(edit?.blocks)).toEqual([]);
  });

  it('says the item changed, and never "already decided", when a 409 finds it still open', async () => {
    const card = await sendCard(approval);
    // The step paused again: the item is open under an origin the card did not read.
    const moved = { ...approval, origin: { ...STEP_ORIGIN, pauseVersion: 1 } } as ActionCenterItem;
    api.items.set(approval.id, moved);

    expect(await tap(card, 'approve')).toBe('item_changed');

    expect(api.items.get(approval.id)?.status).toBe('open');
    const edit = slack.updates[0];
    expect(textOf(edit?.blocks)).toContain(ITEM_CHANGED);
    expect(textOf(edit?.blocks)).not.toContain('Already decided');
    expect(buttonsOf(edit?.blocks)).toEqual([]);

    expect(await tap(card, 'approve')).toBe('item_changed');
    expect(api.resolves).toHaveLength(1);
    expect(slack.posts.at(-1)?.text).toBe(`${TAP_CARD_OUTDATED} ${ITEM_CHANGED}`);
  });

  it('reads the item again when a 409 carries none, and says what it found', async () => {
    const card = await sendCard(approval);
    const stale = {
      ok: false as const,
      status: 409,
      error: 'STALE_ACTION_CENTER_ITEM',
      message: 'The item moved on.',
      retryable: false,
      outcomeUnknown: false,
    };
    api.nextAnswer = stale;

    expect(await tap(card, 'approve')).toBe('item_changed');
    expect(api.reads.at(-1)).toMatchObject({ itemId: approval.id });

    const other = await sendCard(question, 'exec-2');
    api.items.delete(question.id);
    api.nextAnswer = stale;
    expect(await reply(other, 'v2')).toBe('already_decided');
    expect(textOf(slack.updates.at(-1)?.blocks)).toContain('Already decided.');
  });

  it('answers a tap on a message it holds no card record for, and resolves nothing', async () => {
    const outcome = await answerCardTap(
      { slackUserId: OPERATOR, channel: 'D-1', messageTs: '1699999999.000', actionId: 'approve' },
      deps,
    );

    expect(outcome).toBe('no_card');
    expect(api.resolves).toEqual([]);
    expect(slack.posts.at(-1)).toEqual({
      channel: 'D-1',
      text: TAP_NO_CARD,
      threadTs: '1699999999.000',
    });
  });

  it('resolves nothing for a button the card did not offer, and says so', async () => {
    const card = await sendCard(planAsk);
    expect(card.controls).toEqual([]);

    expect(await tap(card, 'approve')).toBe('ignored');
    expect(api.resolves).toEqual([]);
    expect(slack.posts.at(-1)).toMatchObject({ text: TAP_NOT_OFFERED, threadTs: card.ts });
  });

  it('resolves nothing for a tap from anyone but the linked operator', async () => {
    const card = await sendCard(approval);

    expect(await tap(card, 'approve', 'U-STRANGER')).toBe('ignored');
    expect(api.resolves).toEqual([]);
  });

  it('leaves the card as it was when Aflow did not answer, so a tap again can decide', async () => {
    const card = await sendCard(approval);
    api.nextAnswer = {
      ok: false,
      status: 0,
      error: 'UNREACHABLE',
      message: 'Aflow did not answer.',
      retryable: true,
      outcomeUnknown: false,
    };

    expect(await tap(card, 'approve')).toBe('not_sent');
    expect(slack.updates).toEqual([]);
    expect(slack.posts.at(-1)).toMatchObject({ threadTs: card.ts });
    expect(slack.posts.at(-1)?.text).toContain(NOT_SENT_TRY_AGAIN);

    expect(await tap(card, 'approve')).toBe('resolved');
  });

  it.each([
    ['a timeout after the request left', 0, 'UNREACHABLE', 'Aflow did not answer: timed out.'],
    ['a 500 DISPATCH_FAILED', 500, 'DISPATCH_FAILED', 'The resume could not be dispatched.'],
  ])(
    'says the decision may have reached Aflow after %s, and asks for a check before answering again',
    async (_case, status, error, message) => {
      const card = await sendCard(approval);
      api.nextAnswer = { ok: false, status, error, message, retryable: true, outcomeUnknown: true };

      expect(await tap(card, 'approve')).toBe('outcome_unknown');

      expect(slack.updates).toEqual([]);
      expect(store.cardAt(card.channel, card.ts)?.outcome).toBeNull();
      const said = slack.posts.at(-1);
      expect(said?.threadTs).toBe(card.ts);
      expect(said?.text).toContain(OUTCOME_UNKNOWN);
      expect(said?.text).toContain(CHECK_BEFORE_ANSWERING);
      expect(said?.text).not.toContain('nothing was decided');
    },
  );

  it('takes the controls off a card the route refuses, and says it needs Aflow', async () => {
    const card = await sendCard(approval);
    api.nextAnswer = {
      ok: false,
      status: 403,
      error: 'FORBIDDEN',
      message: 'You may not resolve this item.',
      retryable: false,
      outcomeUnknown: false,
    };

    expect(await tap(card, 'approve')).toBe('refused');
    expect(buttonsOf(slack.updates[0]?.blocks)).toEqual([]);
    expect(textOf(slack.updates[0]?.blocks)).toContain('Open the Action Center there');
  });

  it('sends one of two taps that land together, and tells the other to wait', async () => {
    const card = await sendCard(approval);

    const [first, second] = await Promise.all([tap(card, 'approve'), tap(card, 'reject')]);

    expect([first, second]).toEqual(['resolved', 'busy']);
    expect(api.resolves).toHaveLength(1);
    expect(slack.posts.at(-1)).toMatchObject({ text: CARD_BUSY, threadTs: card.ts });
  });
});

describe('free text in a card’s thread', () => {
  it('approves nothing: "yes" leaves the item open, and the app points to the button', async () => {
    const card = await sendCard(approval);

    expect(await reply(card, 'yes')).toBe('pointed');

    expect(api.resolves).toEqual([]);
    expect(api.items.get(approval.id)?.status).toBe('open');
    expect(slack.updates).toEqual([]);
    const pointer = slack.posts.at(-1);
    expect(pointer).toEqual({
      channel: card.channel,
      text: REPLY_DECIDES_NOTHING,
      threadTs: card.ts,
    });
    expect(pointer?.text).toContain('Tap a button on the card above');
  });

  it('approves nothing on a write approval either', async () => {
    const card = await sendCard(writeApproval('medium'));

    expect(await reply(card, 'Yes, approve it.')).toBe('pointed');
    expect(api.resolves).toEqual([]);
    expect(api.items.get(writeApproval('medium').id)?.status).toBe('open');
  });

  it('points a reply on a card with no button to Aflow', async () => {
    const card = await sendCard(planAsk);

    expect(await reply(card, 'yes')).toBe('pointed');
    expect(api.resolves).toEqual([]);
    expect(slack.posts.at(-1)?.text).toBe(REPLY_NEEDS_AFLOW);
  });

  it('answers a question that asks for text, and the card says what and by whom', async () => {
    const card = await sendCard(question);

    expect(await reply(card, '  v1.4.0 &lt;final&gt;  ')).toBe('resolved');

    expect(api.resolves[0]?.resolution).toEqual({ kind: 'submit', payload: 'v1.4.0 <final>' });
    expect(textOf(slack.updates[0]?.blocks)).toContain(
      `Answered “v1.4.0 &lt;final&gt;” by <@${OPERATOR}> from Slack.`,
    );
  });

  it('sends an answer holding &, a URL and a mention as the operator typed it, not as Slack sent it', async () => {
    const card = await sendCard(question);
    const wire =
      'R&amp;D build, see <https://example.com/runs?id=7&amp;tab=log> and ask <@U024BE7LH>';
    const typed = 'R&D build, see https://example.com/runs?id=7&tab=log and ask @U024BE7LH';

    expect(await reply(card, wire)).toBe('resolved');

    expect(api.resolves[0]?.resolution).toEqual({ kind: 'submit', payload: typed });
    expect(textOf(slack.updates[0]?.blocks)).toContain(
      `Answered “R&amp;D build, see https://example.com/runs?id=7&amp;tab=log and ask @U024BE7LH” by <@${OPERATOR}> from Slack.`,
    );
  });

  it('leaves the card open on an answer Aflow refuses as invalid, so a reply again can answer', async () => {
    const card = await sendCard(question);
    api.nextAnswer = {
      ok: false,
      status: 422,
      error: 'INVALID_RESOLUTION',
      message: 'The answer must be at most 8 characters <semver>.',
      retryable: false,
      outcomeUnknown: false,
    };

    expect(await reply(card, 'version one point four')).toBe('invalid_answer');

    expect(slack.updates).toEqual([]);
    expect(store.cardAt(card.channel, card.ts)?.outcome).toBeNull();
    expect(api.items.get(question.id)?.status).toBe('open');
    const said = slack.posts.at(-1);
    expect(said?.threadTs).toBe(card.ts);
    expect(said?.text).toContain('The answer must be at most 8 characters &lt;semver&gt;.');
    expect(said?.text).toContain(REPLY_AGAIN);

    expect(await reply(card, 'v1.4.0')).toBe('resolved');
    expect(textOf(slack.updates[0]?.blocks)).toContain(
      `Answered “v1.4.0” by <@${OPERATOR}> from Slack.`,
    );
  });

  it('decides nothing once the card is settled', async () => {
    const card = await sendCard(question);
    await reply(card, 'v1.4.0');

    expect(await reply(card, 'v1.5.0')).toBe('settled');
    expect(api.resolves).toHaveLength(1);
    expect(slack.posts.at(-1)?.text).toBe(REPLY_CARD_SETTLED);
  });

  it('leaves a thread that is not under a card to the direct-message path', async () => {
    const outcome = await answerCardReply(
      { slackUserId: OPERATOR, channel: 'D-U-OPERATOR', threadTs: '1.999', text: 'yes' },
      deps,
    );
    expect(outcome).toBe('not_a_card');
    expect(slack.posts).toEqual([]);
  });
});

describe('Socket Mode envelopes for cards', () => {
  it('reads a tap from block_actions', () => {
    expect(
      cardTapOf({
        type: 'interactive',
        envelope_id: 'e-1',
        payload: {
          type: 'block_actions',
          user: { id: OPERATOR },
          channel: { id: 'D-1' },
          container: { type: 'message', message_ts: '1700000000.001' },
          actions: [{ action_id: 'approve', value: 'approve' }],
        },
      }),
    ).toEqual({
      slackUserId: OPERATOR,
      channel: 'D-1',
      messageTs: '1700000000.001',
      actionId: 'approve',
    });
  });

  it('reads the thread a direct message replies under, and not a message that starts one', () => {
    const message = (extra: Record<string, unknown>) =>
      directMessageOf({
        type: 'events_api',
        payload: {
          event: {
            type: 'message',
            channel_type: 'im',
            user: OPERATOR,
            channel: 'D-1',
            text: 'yes',
            ts: '1700000001.000',
            ...extra,
          },
        },
      });

    expect(message({ thread_ts: '1700000000.001' })?.threadTs).toBe('1700000000.001');
    expect(message({})?.threadTs).toBeUndefined();
    expect(message({ thread_ts: '1700000001.000' })?.threadTs).toBeUndefined();
  });
});
