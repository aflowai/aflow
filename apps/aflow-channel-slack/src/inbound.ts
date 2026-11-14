/**
 * Where each direct message and each tap goes (Plan 327 D3, D4, D5).
 *
 * A message is asked, in order:
 *
 * 1. Is it from the linked operator, and has this event been handled? A
 *    redelivered event does nothing, a redelivered link code included.
 * 2. Is it the link code, or from anyone but the linked operator? Linking
 *    answers it. A stranger gets one fixed reply, no turn runs and nothing of
 *    theirs is stored. An event that links is recorded in the same step, so its
 *    redelivery does nothing.
 * 3. Is it a reply under a card? The card answers it, and free text approves
 *    nothing.
 * 4. Otherwise it is the conversation's: a late message asks first, a new one
 *    starts a Helmsman conversation, and a reply in its thread continues it.
 *
 * A message that reaches 3 or 4 gets a 👀 reaction first, so the operator sees
 * it has arrived. A redelivered event stops at 1 and gets none.
 *
 * A tap is a late message's **Run it now** or **Discard**, or a card's button.
 */
import { answerCardReply, answerCardTap, type CardOutcome, type CardTap } from './cardActions.js';
import type { ChannelSlackConfig } from './config.js';
import type { ConversationResult, Conversations } from './conversation.js';
import type { AflowApi } from './aflowApi.js';
import { LINK_REPLIES, linkOnMessage } from './linking.js';
import type { SlackClient } from './slack.js';
import type { DirectMessage, SocketModeLog } from './socketMode.js';
import type { ChannelStore } from './store.js';

export interface InboundDeps {
  store: ChannelStore;
  slack: SlackClient;
  api: AflowApi;
  config: ChannelSlackConfig;
  conversations: Conversations;
  log: Pick<SocketModeLog, 'warn'>;
  now?: () => Date;
}

/** The reaction the operator's message gets once the app has taken it. */
export const RECEIVED_REACTION = 'eyes';

export type InboundResult =
  | { outcome: 'linked' | 'code_used' | 'stranger' | 'duplicate' }
  | { outcome: 'card_reply'; card: string }
  | ConversationResult;

export async function answerInbound(
  message: DirectMessage,
  deps: InboundDeps,
): Promise<InboundResult> {
  const fromOperator = deps.store.link()?.slackUserId === message.slackUserId;
  const received = fromOperator ? deps.conversations.receive(message) : undefined;
  if (fromOperator && received === undefined) return { outcome: 'duplicate' };

  const verdict = linkOnMessage(message, {
    store: deps.store,
    config: deps.config,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  if (verdict === 'stranger') {
    await deps.slack.postMessage(message.channel, LINK_REPLIES.stranger);
    return { outcome: 'stranger' };
  }
  // Linking has made the sender the operator, so the event is theirs to record.
  const record = received ?? deps.conversations.receive(message);
  if (record === undefined) return { outcome: 'duplicate' };
  if (verdict !== 'operator') {
    deps.store.settleInbound(record, { outcome: verdict });
    await deps.slack.postMessage(message.channel, LINK_REPLIES[verdict]);
    return { outcome: verdict };
  }

  acknowledge(message, deps);
  if (message.threadTs !== undefined) {
    const reply = await answerCardReply(
      {
        slackUserId: message.slackUserId,
        channel: message.channel,
        threadTs: message.threadTs,
        text: message.text,
      },
      { store: deps.store, slack: deps.slack, api: deps.api },
    );
    if (reply !== 'not_a_card') {
      deps.store.settleInbound(record, { outcome: 'card_reply' });
      return { outcome: 'card_reply', card: reply };
    }
  }
  return deps.conversations.answer(record, message.text);
}

/**
 * Reacts to the operator's message so they see it has arrived. The reaction is
 * not awaited: a slow or refused reaction must not hold back the message.
 */
function acknowledge(message: DirectMessage, deps: Pick<InboundDeps, 'slack' | 'log'>): void {
  const react = async (): Promise<void> => {
    await deps.slack.addReaction(message.channel, message.ts, RECEIVED_REACTION);
  };
  react().catch((error: unknown) => {
    deps.log.warn('Slack would not add the received reaction to a message', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function answerTap(
  tap: CardTap,
  deps: Pick<InboundDeps, 'store' | 'slack' | 'api' | 'conversations'>,
): Promise<CardOutcome | ConversationResult> {
  if (deps.conversations.isLateQuestion(tap)) return deps.conversations.answerLateTap(tap);
  return answerCardTap(tap, { store: deps.store, slack: deps.slack, api: deps.api });
}
