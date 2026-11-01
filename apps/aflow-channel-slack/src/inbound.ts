/**
 * Where each direct message and each tap goes (Plan 327 D3, D4, D5).
 *
 * A message is asked, in order:
 *
 * 1. Is it the link code, or from anyone but the linked operator? Linking
 *    answers it. A stranger gets one fixed reply, no turn runs and nothing of
 *    theirs is stored.
 * 2. Has this event been handled? A redelivered event does nothing.
 * 3. Is it a reply under a card? The card answers it, and free text approves
 *    nothing.
 * 4. Otherwise it is the conversation's: a late message asks first, a new one
 *    starts a Helmsman conversation, and a reply in its thread continues it.
 *
 * A tap is a late message's **Run it now** or **Discard**, or a card's button.
 */
import { answerCardReply, answerCardTap, type CardOutcome, type CardTap } from './cardActions.js';
import type { ChannelSlackConfig } from './config.js';
import type { ConversationResult, Conversations } from './conversation.js';
import type { AflowApi } from './aflowApi.js';
import { answerDirectMessage } from './linking.js';
import type { SlackClient } from './slack.js';
import type { DirectMessage } from './socketMode.js';
import type { ChannelStore } from './store.js';

export interface InboundDeps {
  store: ChannelStore;
  slack: SlackClient;
  api: AflowApi;
  config: ChannelSlackConfig;
  conversations: Conversations;
  now?: () => Date;
}

export type InboundResult =
  | { outcome: 'linked' | 'code_used' | 'stranger' | 'duplicate' }
  | { outcome: 'card_reply'; card: string }
  | ConversationResult;

export async function answerInbound(
  message: DirectMessage,
  deps: InboundDeps,
): Promise<InboundResult> {
  const linking = await answerDirectMessage(message, {
    store: deps.store,
    config: deps.config,
    slack: deps.slack,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  if (linking !== 'operator') return { outcome: linking };

  const record = deps.conversations.receive(message);
  if (record === undefined) return { outcome: 'duplicate' };

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

export async function answerTap(
  tap: CardTap,
  deps: Pick<InboundDeps, 'store' | 'slack' | 'api' | 'conversations'>,
): Promise<CardOutcome | ConversationResult> {
  if (deps.conversations.isLateQuestion(tap)) return deps.conversations.answerLateTap(tap);
  return answerCardTap(tap, { store: deps.store, slack: deps.slack, api: deps.api });
}
