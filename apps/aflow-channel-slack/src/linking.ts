/**
 * Linking (Plan 327 D5): setup prints a one-time code, the operator sends it to
 * the bot from Slack, and the app links that Slack user to the key's user. From
 * then on it serves only that Slack user.
 *
 * Anyone else gets one fixed reply. No turn runs, and the text of their message
 * is neither stored nor logged.
 */
import { timingSafeEqual } from 'node:crypto';

import type { ChannelSlackConfig } from './config.js';
import type { DirectMessage } from './socketMode.js';
import type { SlackClient } from './slack.js';
import { sha256Hex, type ChannelStore } from './store.js';

export const STRANGER_REPLY =
  'This app serves one person, and this Slack account is not linked to it.';

export const LINKED_REPLY =
  'Linked. Aflow sends you its messages here when you must act and may be away from the machine.';

export const CODE_ALREADY_USED_REPLY =
  'This code has already linked this account, so it changed nothing. It was not sent to the Helmsman.';

/** A code as typed: case, spaces and dashes do not matter. */
export function normalizeLinkCode(text: string): string {
  return text.replace(/[\s-]/g, '').toUpperCase();
}

function matchesCode(text: string, config: ChannelSlackConfig, now: Date): string | undefined {
  const expected = config.CHANNEL_SLACK_LINK_CODE_SHA256;
  const expiresAt = config.CHANNEL_SLACK_LINK_CODE_EXPIRES_AT;
  if (expected === undefined || expiresAt === undefined) return undefined;
  if (!(now.getTime() < Date.parse(expiresAt))) return undefined;
  const offered = sha256Hex(normalizeLinkCode(text));
  const same = timingSafeEqual(Buffer.from(offered, 'hex'), Buffer.from(expected, 'hex'));
  return same ? offered : undefined;
}

/**
 * Links on the code, refuses a stranger, and posts nothing for any other
 * message from the linked operator: `operator` hands it on to the caller. A
 * code the operator sends again, a redelivered one included, is answered here
 * and never reaches the Helmsman.
 */
export async function answerDirectMessage(
  message: Pick<DirectMessage, 'slackUserId' | 'slackTeamId' | 'channel' | 'text'>,
  deps: { store: ChannelStore; config: ChannelSlackConfig; slack: SlackClient; now?: () => Date },
): Promise<'linked' | 'code_used' | 'operator' | 'stranger'> {
  const now = deps.now?.() ?? new Date();
  const code = matchesCode(message.text, deps.config, now);
  if (code !== undefined) {
    const linked = deps.store.linkWithCode(code, {
      slackUserId: message.slackUserId,
      ...(message.slackTeamId === undefined ? {} : { slackTeamId: message.slackTeamId }),
      aflowUserId: deps.config.AFLOW_USER_ID,
      tenantId: deps.config.AFLOW_TENANT_ID,
      linkedAt: now.toISOString(),
    });
    if (linked) {
      await deps.slack.postMessage(message.channel, LINKED_REPLY);
      return 'linked';
    }
  }
  if (deps.store.link()?.slackUserId === message.slackUserId) {
    if (code === undefined) return 'operator';
    await deps.slack.postMessage(message.channel, CODE_ALREADY_USED_REPLY);
    return 'code_used';
  }
  await deps.slack.postMessage(message.channel, STRANGER_REPLY);
  return 'stranger';
}
