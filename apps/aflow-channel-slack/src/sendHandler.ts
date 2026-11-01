/**
 * `channel.message.send` (Plan 327 D2): one text message to the linked
 * operator, posted synchronously.
 *
 * The rules, in the order they are asked:
 *
 * - A step whose message was already posted returns that message and posts
 *   nothing. Keyed on the run and the logical execution, which a retry keeps,
 *   so a retry after a lost result posts once. The run is part of the key
 *   because a workflow task's logical execution is `task:<taskId>` in every
 *   run of it, and each run posts its own message.
 * - A post that left but drew no readable answer may have landed: a transport
 *   failure, the timeout, an HTTP 5xx, or a body that could not be read. It
 *   fails not retryable and is recorded, so neither a retry nor the same text
 *   again in the run posts it twice.
 * - The send is claimed in the store before it leaves, in the same synchronous
 *   step that asks whether it was sent. The runtime runs sends concurrently, so
 *   of two that arrive together the second fails and posts nothing.
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
import type { ChannelStore, SentRecord } from './store.js';

export const CHANNEL_RECIPIENT_NOT_LINKED_CODE = 'CHANNEL_RECIPIENT_NOT_LINKED';
export const CHANNEL_MESSAGE_REPEATED_CODE = 'CHANNEL_MESSAGE_REPEATED';
export const CHANNEL_PROVIDER_ERROR_CODE = 'CHANNEL_PROVIDER_ERROR';
export const CHANNEL_DELIVERY_UNKNOWN_CODE = 'CHANNEL_DELIVERY_UNKNOWN';

export const NOT_LINKED_MESSAGE =
  'The person this run works for is not the operator linked to this channel, so nothing was ' +
  'sent. The operator links Slack from their aflow checkout: `yarn channel:slack setup` prints a ' +
  'one-time code, which they send to the bot from Slack. The help article "How do I reach Aflow ' +
  'from Slack" (/help/slack-channel) walks through it. Do not retry this send.';

export const REPEATED_MESSAGE =
  'This run already sent the operator exactly this text, so it was not sent again. Say something ' +
  'new, or stop: the operator has the first message.';

export const IN_FLIGHT_MESSAGE =
  'This run is sending the operator exactly this text at this moment, so it was not sent a second ' +
  'time. Do not send it again: the first send stands.';

export const DELIVERY_UNKNOWN_MESSAGE =
  'The message was sent to Slack, but no answer came back, so Slack may have posted it. It was ' +
  'not sent again, because a second send could post it twice. Do not send this text again in this ' +
  'run. If the operator must have it, say so in your reply instead.';

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

    const posted = this.deps.store.sentFor(ctx.runId, ctx.logicalExecutionId);
    if (posted !== undefined) return this.refuse(ctx, posted);

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

    const now = this.deps.now?.() ?? new Date();
    const claim = this.deps.store.claimSend(
      {
        executionId: ctx.logicalExecutionId,
        runId: ctx.runId,
        text,
        sentAt: now.toISOString(),
      },
      now,
    );
    if (!claim.claimed) return this.refuse(ctx, claim.prior);

    let messageRef: string;
    let posting = false;
    try {
      const channel = await this.deps.slack.openDirectMessage(link.slackUserId);
      posting = true;
      const message = await this.deps.slack.postMessage(channel, text);
      messageRef = `slack:${message.channel}:${message.ts}`;
    } catch (error) {
      if (posting && !(error instanceof SlackApiError && !error.outcomeUnknown)) {
        this.deps.store.settleSend(claim.record, null);
        return this.deliveryUnknown(
          ctx,
          error instanceof SlackApiError
            ? error.slackError
            : error instanceof Error
              ? error.message
              : 'unknown error',
        );
      }
      this.deps.store.releaseSend(claim.record);
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

    this.deps.store.settleSend(claim.record, messageRef);
    return this.delivered(ctx, messageRef);
  }

  /**
   * Answers a send that a record already stands in the way of. A send still in
   * flight in this process counts as a repeat, whatever it ends as.
   */
  private refuse(ctx: ExecutorContext, prior: SentRecord): Promise<StepResult> {
    const sameStep = prior.runId === ctx.runId && prior.executionId === ctx.logicalExecutionId;
    if (this.deps.store.inFlight(prior)) {
      return failureWithError(
        ctx,
        aflowError(CHANNEL_MESSAGE_REPEATED_CODE, IN_FLIGHT_MESSAGE, 'validation', false),
      );
    }
    if (prior.messageRef === null) {
      return this.deliveryUnknown(
        ctx,
        sameStep
          ? 'an earlier attempt at this step had no answer from Slack'
          : 'an earlier send of this text had no answer from Slack',
      );
    }
    if (sameStep) return this.delivered(ctx, prior.messageRef);
    return failureWithError(
      ctx,
      aflowError(CHANNEL_MESSAGE_REPEATED_CODE, REPEATED_MESSAGE, 'validation', false),
    );
  }

  /**
   * Not retryable: a retry would post the same text a second time if Slack
   * took the first. The record makes a later attempt at this step, or the same
   * text again in this run, refuse rather than post.
   */
  private deliveryUnknown(ctx: ExecutorContext, cause: string): Promise<StepResult> {
    return failureWithError(
      ctx,
      aflowError(
        CHANNEL_DELIVERY_UNKNOWN_CODE,
        `${DELIVERY_UNKNOWN_MESSAGE} (${cause})`,
        'provider',
        false,
      ),
    );
  }

  private delivered(ctx: ExecutorContext, messageRef: string): Promise<StepResult> {
    const output: ChannelMessageSendOutput = { delivered: true, messageRef };
    return successWithData(ctx, output);
  }
}
