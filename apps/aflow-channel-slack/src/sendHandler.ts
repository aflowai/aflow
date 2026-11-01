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
 * - A run that already delivered the same text with the same item fails,
 *   because the loop guards count failures and a model repeating itself must
 *   meet one.
 * - An `itemId` is read through the API in the run's own space and sent as a
 *   card with the controls the D3 table allows (`cards.ts`). A missing or
 *   decided item fails before anything is claimed or posted.
 * - Every call out, to Aflow and to Slack, ends when the step's signal does.
 *   The step's timeout then answers as this handler's own result: a post the
 *   timeout cut short fails as an unknown delivery, not retryable, instead of
 *   as a retryable timeout that would post it again.
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
  type ActionCenterItem,
  type AflowError,
  type ChannelMessageSendOutput,
  type ErrorClassification,
} from '@aflow/schemas';

import type { AflowApi, ObservedOrigin } from './aflowApi.js';
import { cardHead, openFoot, planCard, type CardPlan } from './cards.js';
import { SlackApiError, type PostedMessage, type SlackClient } from './slack.js';
import type { ChannelStore, SentRecord } from './store.js';

export const CHANNEL_RECIPIENT_NOT_LINKED_CODE = 'CHANNEL_RECIPIENT_NOT_LINKED';
export const CHANNEL_MESSAGE_REPEATED_CODE = 'CHANNEL_MESSAGE_REPEATED';
export const CHANNEL_PROVIDER_ERROR_CODE = 'CHANNEL_PROVIDER_ERROR';
export const CHANNEL_DELIVERY_UNKNOWN_CODE = 'CHANNEL_DELIVERY_UNKNOWN';
export const CHANNEL_ITEM_NOT_FOUND_CODE = 'CHANNEL_ITEM_NOT_FOUND';
export const CHANNEL_ITEM_NOT_OPEN_CODE = 'CHANNEL_ITEM_NOT_OPEN';
export const CHANNEL_ITEM_UNREADABLE_CODE = 'CHANNEL_ITEM_UNREADABLE';

interface ReadCard {
  item: ActionCenterItem;
  origin: ObservedOrigin;
  plan: CardPlan;
}

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
      api: AflowApi;
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
    const { text, itemId } = parsed.data;

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

    let card: ReadCard | undefined;
    if (itemId !== undefined) {
      const read = await this.readCard(ctx, itemId);
      if ('failure' in read) return read.failure;
      card = read;
    }

    const now = this.deps.now?.() ?? new Date();
    const claim = this.deps.store.claimSend(
      {
        executionId: ctx.logicalExecutionId,
        runId: ctx.runId,
        text,
        ...(itemId === undefined ? {} : { itemId }),
        sentAt: now.toISOString(),
      },
      now,
    );
    if (!claim.claimed) return this.refuse(ctx, claim.prior);

    const head = card === undefined ? undefined : cardHead(text, card.item);
    let message: PostedMessage;
    let posting = false;
    try {
      const channel = await this.deps.slack.openDirectMessage(link.slackUserId, ctx.signal);
      posting = true;
      message = await this.deps.slack.postMessage(channel, text, {
        signal: ctx.signal,
        ...(card === undefined || head === undefined
          ? {}
          : { blocks: [...head, ...openFoot(card.plan, card.item.title)] }),
      });
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

    const messageRef = `slack:${message.channel}:${message.ts}`;
    this.deps.store.settleSend(claim.record, messageRef);
    if (card !== undefined && head !== undefined) {
      this.deps.store.addCard({
        channel: message.channel,
        ts: message.ts,
        itemId: card.item.id,
        spaceId: card.item.spaceId,
        origin: card.origin,
        title: card.item.title,
        row: card.plan.row,
        controls: card.plan.controls,
        head,
        text,
        postedAt: now.toISOString(),
        outcome: null,
      });
    }
    return this.delivered(ctx, messageRef);
  }

  /**
   * The item `itemId` names in this run's space, read through the API as the
   * web app reads it. Only an open item is sent: a decided one has nothing to
   * ask the operator.
   */
  private async readCard(
    ctx: ExecutorContext,
    itemId: string,
  ): Promise<ReadCard | { failure: Promise<StepResult> }> {
    const fail = (
      code: string,
      message: string,
      classification: ErrorClassification,
      retryable: boolean,
    ) => ({ failure: failureWithError(ctx, aflowError(code, message, classification, retryable)) });

    if (ctx.spaceId === undefined) {
      return fail(
        CHANNEL_ITEM_UNREADABLE_CODE,
        'This run carries no space, so no Action Center item can be sent from it. Send the text alone.',
        'validation',
        false,
      );
    }
    const read = await this.deps.api.readItem(ctx.spaceId, itemId, ctx.signal);
    if (!read.ok) {
      if (read.status === 404) {
        return fail(
          CHANNEL_ITEM_NOT_FOUND_CODE,
          `No Action Center item ${itemId} is in this run's space, so nothing was sent. Send the id ` +
            'of an open item from this space, or send the text alone.',
          'validation',
          false,
        );
      }
      return fail(
        CHANNEL_ITEM_UNREADABLE_CODE,
        `The channel app could not read item ${itemId} from Aflow, so nothing was sent: ${read.message}`,
        read.retryable ? 'provider' : 'configuration',
        read.retryable,
      );
    }
    if (read.item.status !== 'open') {
      return fail(
        CHANNEL_ITEM_NOT_OPEN_CODE,
        `Item ${itemId} is already ${read.item.status}, so nothing was sent. It needs no answer ` +
          'from the operator. Do not send it again.',
        'validation',
        false,
      );
    }
    return { item: read.item, origin: read.origin, plan: planCard(read.item) };
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
