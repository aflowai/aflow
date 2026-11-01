/**
 * What the operator does to a card (Plan 327 D3): a tap on one of its buttons,
 * or a reply in its thread.
 *
 * A tap names a control by id, and the resolution comes from the card's own
 * record, so it can ask for nothing the card did not offer. It is sent to the
 * resolve route the web app calls, with the origin the app read, and the card
 * is edited to say what was decided and by whom. A tap on an item that is no
 * longer open gets the route's own answer, and the card says it was already
 * decided. A tap on a card that already has an outcome is not sent. The app
 * answers it in the thread from the card's record, so the card keeps its note.
 *
 * Free text never approves anything. A reply in a card's thread answers only
 * a question that asks for text. On any other card it leaves the item open,
 * and the app points to the button or to Aflow. An answer the route refuses as
 * invalid (422) leaves the card open with the route's reason, so the operator
 * can reply again. The answer is sent as the operator typed it, not in Slack's
 * wire encoding.
 *
 * A failure that may succeed if sent again leaves the card open. When no
 * connection was made, nothing was decided, and the app says so. When the
 * request may have reached Aflow, the app says the item may have been decided
 * and asks the operator to look at it before answering again.
 */
import type { ActionCenterResolution } from '@aflow/schemas';

import type { AflowApi, ResolvedItem, RouteRefusal } from './aflowApi.js';
import { escapeMrkdwn, outcomeFoot } from './cards.js';
import type { SlackBlock, SlackClient } from './slack.js';
import { typedTextOf } from './slackText.js';
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

export const TAP_ALREADY_DECIDED = 'Already decided. This tap changed nothing.';

export const CARD_BUSY =
  'A decision on this card is on its way to Aflow. Wait for the card to change before you tap again.';

export const REPLY_AGAIN = 'Reply again in this thread to answer.';

export const NOT_SENT_TRY_AGAIN = 'This did not reach Aflow, so nothing was decided:';

export const OUTCOME_UNKNOWN =
  'This may or may not have reached Aflow, so the item may already be decided:';

export const CHECK_BEFORE_ANSWERING =
  'Open the item in the Action Center at Aflow and check it before you answer again.';

export type CardOutcome =
  | 'resolved'
  | 'already_decided'
  | 'refused'
  | 'invalid_answer'
  | 'not_sent'
  | 'outcome_unknown'
  | 'busy'
  | 'ignored';

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
): string {
  if (answer.ok) return `${decided} by <@${slackUserId}> from Slack.`;
  // The route answers a decided item with a stale origin (409), or with no item at all (404).
  if (answer.status === 409 || answer.status === 404) {
    return `Already decided. This tap changed nothing. Aflow answered: ${escapeMrkdwn(answer.message)}`;
  }
  return (
    `Aflow refused this decision: ${escapeMrkdwn(answer.message)} ` +
    'Open the Action Center there to decide it.'
  );
}

function outcomeOf(answer: ResolvedItem | RouteRefusal): CardOutcome {
  if (answer.ok) return 'resolved';
  if (answer.status === 409 || answer.status === 404) return 'already_decided';
  if (!answer.retryable) return 'refused';
  return answer.outcomeUnknown ? 'outcome_unknown' : 'not_sent';
}

function retryAdvice(answer: RouteRefusal): string {
  const message = escapeMrkdwn(answer.message);
  return answer.outcomeUnknown
    ? `${OUTCOME_UNKNOWN} ${message} ${CHECK_BEFORE_ANSWERING}`
    : `${NOT_SENT_TRY_AGAIN} ${message} Try again.`;
}

/**
 * Sends `resolution` for the card's item and edits the card to say how it
 * ended. With `reasks`, a 422 leaves the card open, because the operator can
 * send a different text answer. A button sends the card's own recorded answer,
 * which cannot change, so a 422 on a tap settles the card as refused.
 */
async function decide(
  card: CardRecord,
  resolution: ActionCenterResolution,
  decided: string,
  slackUserId: string,
  deps: CardDeps,
  reasks = false,
): Promise<CardOutcome> {
  if (!deps.store.claimCard(card)) {
    await deps.slack.postMessage(card.channel, CARD_BUSY, { threadTs: card.ts });
    return 'busy';
  }
  try {
    const answer = await deps.api.resolveItem(card.spaceId, card.itemId, card.origin, resolution);
    if (reasks && !answer.ok && answer.status === 422) {
      await deps.slack.postMessage(
        card.channel,
        `Aflow did not take this answer, and the item is still open: ${escapeMrkdwn(answer.message)} ${REPLY_AGAIN}`,
        { threadTs: card.ts },
      );
      return 'invalid_answer';
    }
    if (!answer.ok && answer.retryable) {
      await deps.slack.postMessage(card.channel, retryAdvice(answer), { threadTs: card.ts });
      return outcomeOf(answer);
    }
    const note = noteFor(answer, decided, slackUserId);
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
  if (card.outcome !== null) {
    // The route would answer 409, and that answer would replace the note that says who decided.
    await deps.slack.postMessage(card.channel, `${TAP_ALREADY_DECIDED} ${card.outcome.note}`, {
      threadTs: card.ts,
    });
    return 'already_decided';
  }
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
  const answer = typedTextOf(reply.text).trim();
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
    true,
  );
}
