/**
 * What the operator does to a card (Plan 327 D3): a tap on one of its buttons,
 * or a reply in its thread.
 *
 * A tap names a control by id, and the resolution comes from the card's own
 * record, so it can ask for nothing the card did not offer. It is sent to the
 * resolve route the web app calls, with the origin the app read, and the card
 * is edited to say what was decided and by whom. A tap on an item that is no
 * longer open gets the route's own answer, and the card says it was already
 * decided.
 *
 * Free text never approves anything. A reply in a card's thread answers only
 * a question that asks for text. On any other card it leaves the item open,
 * and the app points to the button or to Aflow.
 */
import type { ActionCenterResolution } from '@aflow/schemas';

import type { AflowApi, ResolvedItem, RouteRefusal } from './aflowApi.js';
import { escapeMrkdwn, outcomeFoot } from './cards.js';
import type { SlackBlock, SlackClient } from './slack.js';
import type { CardRecord, ChannelStore } from './store.js';

export interface CardTap {
  slackUserId: string;
  channel: string;
  messageTs: string;
  actionId: string;
}

export interface CardReply {
  slackUserId: string;
  channel: string;
  threadTs: string;
  text: string;
}

export const REPLY_DECIDES_NOTHING =
  'A reply here decides nothing, and the item is still open. Tap a button on the card above to answer it.';

export const REPLY_NEEDS_AFLOW =
  'A reply here decides nothing, and the item is still open. It needs you at Aflow: open the Action Center there to decide it.';

export const REPLY_CARD_SETTLED = 'This card is settled, so a reply here decides nothing.';

export const CARD_BUSY =
  'A decision on this card is on its way to Aflow. Wait for the card to change before you tap again.';

export type CardOutcome =
  'resolved' | 'already_decided' | 'refused' | 'not_sent' | 'busy' | 'ignored';

export type ReplyOutcome = CardOutcome | 'not_a_card' | 'pointed' | 'settled';

interface CardDeps {
  store: ChannelStore;
  slack: SlackClient;
  api: AflowApi;
  now?: () => Date;
}

const MAX_QUOTED_ANSWER = 200;

function quoted(text: string): string {
  const short =
    text.length <= MAX_QUOTED_ANSWER ? text : `${text.slice(0, MAX_QUOTED_ANSWER - 1)}…`;
  return escapeMrkdwn(short);
}

function noteFor(
  answer: ResolvedItem | RouteRefusal,
  decided: string,
  slackUserId: string,
): string | undefined {
  if (answer.ok) return `${decided} by <@${slackUserId}> from Slack.`;
  // The route answers a decided item with a stale origin (409), or with no item at all (404).
  if (answer.status === 409 || answer.status === 404) {
    return `Already decided. This tap changed nothing. Aflow answered: ${escapeMrkdwn(answer.message)}`;
  }
  if (answer.retryable) return undefined;
  return (
    `Aflow refused this decision: ${escapeMrkdwn(answer.message)} ` +
    'Open the Action Center there to decide it.'
  );
}

function outcomeOf(answer: ResolvedItem | RouteRefusal): CardOutcome {
  if (answer.ok) return 'resolved';
  if (answer.status === 409 || answer.status === 404) return 'already_decided';
  return answer.retryable ? 'not_sent' : 'refused';
}

/** Sends `resolution` for the card's item and edits the card to say how it ended. */
async function decide(
  card: CardRecord,
  resolution: ActionCenterResolution,
  decided: string,
  slackUserId: string,
  deps: CardDeps,
): Promise<CardOutcome> {
  if (!deps.store.claimCard(card)) {
    await deps.slack.postMessage(card.channel, CARD_BUSY, { threadTs: card.ts });
    return 'busy';
  }
  try {
    const answer = await deps.api.resolveItem(card.spaceId, card.itemId, card.origin, resolution);
    const note = noteFor(answer, decided, slackUserId);
    if (note === undefined) {
      const message = answer.ok ? '' : escapeMrkdwn(answer.message);
      await deps.slack.postMessage(
        card.channel,
        `This did not reach Aflow, so nothing was decided: ${message} Try again.`,
        { threadTs: card.ts },
      );
      return outcomeOf(answer);
    }
    deps.store.settleCard(card, note, deps.now?.() ?? new Date());
    const blocks: SlackBlock[] = [...(card.head as SlackBlock[]), ...outcomeFoot(note)];
    await deps.slack.updateMessage(card.channel, card.ts, card.text, blocks);
    return outcomeOf(answer);
  } finally {
    deps.store.releaseCard(card);
  }
}

/** A tap on a card's button, from Slack's `block_actions`. */
export async function answerCardTap(tap: CardTap, deps: CardDeps): Promise<CardOutcome> {
  if (deps.store.link()?.slackUserId !== tap.slackUserId) return 'ignored';
  const card = deps.store.cardAt(tap.channel, tap.messageTs);
  const control = card?.controls.find((entry) => entry.id === tap.actionId);
  if (card === undefined || control === undefined) return 'ignored';
  return decide(card, control.resolution, control.decided, tap.slackUserId, deps);
}

/**
 * A message in a card's thread. `not_a_card` when the thread is not under a
 * card, so the caller answers it as any other direct message.
 */
export async function answerCardReply(reply: CardReply, deps: CardDeps): Promise<ReplyOutcome> {
  if (deps.store.link()?.slackUserId !== reply.slackUserId) return 'not_a_card';
  const card = deps.store.cardAt(reply.channel, reply.threadTs);
  if (card === undefined) return 'not_a_card';
  const say = (text: string) => deps.slack.postMessage(card.channel, text, { threadTs: card.ts });

  if (card.outcome !== null) {
    await say(REPLY_CARD_SETTLED);
    return 'settled';
  }
  const answer = reply.text.trim();
  if (card.row !== 'text_reply' || answer === '') {
    await say(card.controls.length > 0 ? REPLY_DECIDES_NOTHING : REPLY_NEEDS_AFLOW);
    return 'pointed';
  }
  return decide(
    card,
    { kind: 'submit', payload: answer },
    `Answered “${quoted(answer)}”`,
    reply.slackUserId,
    deps,
  );
}
