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

export const LINKED_OPERATOR_REPLY =
  'Aflow sends you its messages here, and a card’s buttons decide its item from here. Talking ' +
  'to Aflow from Slack comes in a later release, so open Aflow to ask it something.';

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

export async function answerDirectMessage(
  message: DirectMessage,
  deps: { store: ChannelStore; config: ChannelSlackConfig; slack: SlackClient; now?: () => Date },
): Promise<'linked' | 'operator' | 'stranger'> {
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
    await deps.slack.postMessage(message.channel, LINKED_OPERATOR_REPLY);
    return 'operator';
  }
  await deps.slack.postMessage(message.channel, STRANGER_REPLY);
  return 'stranger';
}
