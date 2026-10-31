/**
 * `channel.message.send` (Plan 327 D2): one text message to the linked
 * operator, posted synchronously.
 *
 * The rules, in the order they are asked:
 *
 * - A step whose message was already posted returns that message and posts
 *   nothing. Keyed on the logical execution, which a retry keeps, so a retry
 *   after a lost result posts once.
 * - The recipient is the person the run works for, `credentialOwnerId` on the
 *   job, and it must be the operator this app linked. Nothing in the input can
 *   name another.
 * - A run that already delivered the same text fails, because the loop guards
 *   count failures and a model repeating itself must meet one.
 */
import {
  failureWithError,
  successWithData,
  type ExecutorContext,
  type StepHandler,
  type StepResult,
} from '@aflow/executor-runtime';
import {
  CHANNEL_MESSAGE_SEND_OPERATION_ID,
  ChannelMessageSendInputSchema,
  type AflowError,
  type ChannelMessageSendOutput,
  type ErrorClassification,
} from '@aflow/schemas';

import { SlackApiError, type SlackClient } from './slack.js';
import type { ChannelStore } from './store.js';

export const CHANNEL_RECIPIENT_NOT_LINKED_CODE = 'CHANNEL_RECIPIENT_NOT_LINKED';
export const CHANNEL_MESSAGE_REPEATED_CODE = 'CHANNEL_MESSAGE_REPEATED';
export const CHANNEL_PROVIDER_ERROR_CODE = 'CHANNEL_PROVIDER_ERROR';

export const NOT_LINKED_MESSAGE =
  'The person this run works for is not the operator linked to this channel, so nothing was ' +
  'sent. The operator links Slack under Settings → Channels: `yarn channel:slack setup` prints a ' +
  'one-time code, which they send to the bot from Slack. Do not retry this send.';

export const REPEATED_MESSAGE =
  'This run already sent the operator exactly this text, so it was not sent again. Say something ' +
  'new, or stop: the operator has the first message.';

function aflowError(
  code: string,
  message: string,
  classification: ErrorClassification,
  retryable: boolean,
): AflowError {
  return { code, message, classification, retryable, timestamp: new Date().toISOString() };
}

export class ChannelMessageSendHandler implements StepHandler {
  readonly stepType = 'channel';

  constructor(
    private readonly deps: {
      store: ChannelStore;
      slack: SlackClient;
      now?: () => Date;
    },
  ) {}

  async execute(ctx: ExecutorContext): Promise<StepResult> {
    if (ctx.job.operationId !== CHANNEL_MESSAGE_SEND_OPERATION_ID) {
      return failureWithError(
        ctx,
        aflowError(
          'UNKNOWN_OPERATION',
          `The channel app serves ${CHANNEL_MESSAGE_SEND_OPERATION_ID} only, not ${ctx.job.operationId}.`,
          'validation',
          false,
        ),
      );
    }

    const parsed = ChannelMessageSendInputSchema.safeParse(await ctx.readPayload(ctx.job.inputRef));
    if (!parsed.success) {
      return failureWithError(
        ctx,
        aflowError(
          'INVALID_INPUT',
          parsed.error.issues.map((issue) => issue.message).join(' '),
          'validation',
          false,
        ),
      );
    }
    const { text } = parsed.data;

    const posted = this.deps.store.sentFor(ctx.logicalExecutionId);
    if (posted !== undefined) {
      return this.delivered(ctx, posted.messageRef);
    }

    const link = this.deps.store.link();
    const recipient = ctx.job.credentialOwnerId;
    if (
      link === null ||
      recipient === undefined ||
      recipient !== link.aflowUserId ||
      ctx.tenantId !== link.tenantId
    ) {
      return failureWithError(
        ctx,
        aflowError(CHANNEL_RECIPIENT_NOT_LINKED_CODE, NOT_LINKED_MESSAGE, 'permission', false),
      );
    }

    if (this.deps.store.sentInRun(ctx.runId, text) !== undefined) {
      return failureWithError(
        ctx,
        aflowError(CHANNEL_MESSAGE_REPEATED_CODE, REPEATED_MESSAGE, 'validation', false),
      );
    }

    let messageRef: string;
    try {
      const channel = await this.deps.slack.openDirectMessage(link.slackUserId);
      const message = await this.deps.slack.postMessage(channel, text);
      messageRef = `slack:${message.channel}:${message.ts}`;
    } catch (error) {
      const retryable = error instanceof SlackApiError ? error.retryable : true;
      return failureWithError(
        ctx,
        aflowError(
          CHANNEL_PROVIDER_ERROR_CODE,
          `Slack did not take the message: ${error instanceof Error ? error.message : 'unknown error'}.`,
          retryable ? 'provider' : 'configuration',
          retryable,
        ),
      );
    }

    this.deps.store.recordSent({
      executionId: ctx.logicalExecutionId,
      runId: ctx.runId,
      text,
      messageRef,
      sentAt: (this.deps.now?.() ?? new Date()).toISOString(),
    });
    return this.delivered(ctx, messageRef);
  }

  private delivered(ctx: ExecutorContext, messageRef: string): Promise<StepResult> {
    const output: ChannelMessageSendOutput = { delivered: true, messageRef };
    return successWithData(ctx, output);
  }
}
