/**
 * A conversation with the Helmsman from Slack (Plan 327 D4).
 *
 * A direct message from the linked operator starts a Helmsman session in
 * their home space. A reply in that message's thread resumes the same session,
 * so the thread stays one conversation. The app watches only the sessions it
 * started, and posts the Helmsman's answer into the thread once the session
 * pauses with it.
 *
 * - **The operator's own posture.** The calls carry the owner's key, and the
 *   link must name the key's user. A start uses mode `api`, which the session
 *   route admits from a key, and a resume names the paused step the last
 *   `SessionPaused` named, as the resume route requires. Nothing is granted for
 *   the channel.
 * - **Once.** Each event is recorded before anything acts on it, and a
 *   redelivered one does nothing. The start and the resume carry the event id
 *   as their idempotency key too.
 * - **A late message asks first.** A message older than the threshold when it
 *   arrives is not sent. The app asks whether to run it, and a message run
 *   late tells the Helmsman when it was sent and that the operator chose to run
 *   it.
 * - **An unknown outcome is not sent again.** A start or a resume that may have
 *   reached Aflow says so, and asks the operator to check before sending again.
 *   A resume that may have landed is watched as one that did, so its answer is
 *   posted once if it comes.
 * - **One message per thread at a time.** A message claims its thread before it
 *   starts or resumes the conversation. Of two that arrive together, one is
 *   sent and the other is told the Helmsman is still answering.
 */
import type { AflowApi, ConversationEvent, RouteRefusal } from './aflowApi.js';
import type { CardTap } from './cardActions.js';
import { escapeMrkdwn } from './cards.js';
import { SlackApiError, type SlackBlock, type SlackClient } from './slack.js';
import type { DirectMessage } from './socketMode.js';
import { typedTextOf } from './slackText.js';
import type { ChannelStore, InboundOutcome, InboundRecord, ThreadRecord } from './store.js';

/** Plan 327 §8: ten minutes for P2, measured from the `inbound` record. */
export const LATE_THRESHOLD_MS = 10 * 60 * 1000;
export const LATE_RUN_ACTION = 'late:run';
export const LATE_DISCARD_ACTION = 'late:discard';

export const LATE_QUESTION = 'This arrived late. Run it now?';

export const LATE_ALREADY_DECIDED = 'This late message was already run or discarded.';

export const LATE_BUSY = 'This late message is on its way. Wait for the question to change.';

export const STILL_ANSWERING =
  'The Helmsman is still answering in this thread, so this message was not sent. Send it again once the answer is here.';

export const CONVERSATION_ENDED =
  'This conversation has ended, so this message was not sent. Send a new direct message to start another.';

export const WAITS_AT_AFLOW =
  'The Helmsman waits on something that needs you at Aflow before it answers. Open the conversation there.';

export const ANSWER_TAKES_LONG =
  'The answer is taking longer than this thread waits for it. It will be in the conversation at Aflow, and a reply here continues it.';

export const NOT_SENT = 'This did not reach Aflow, so the Helmsman did not get it:';

export const MAYBE_SENT = 'This may or may not have reached the Helmsman:';

export const CHECK_AT_AFLOW =
  'Open the conversation at Aflow and check it before you send this again.';

export const MOVED_ON =
  'The conversation moved on at Aflow, so this was not sent. Send it again to continue from there.';

export const ANSWER_NOT_POSTED =
  'The Helmsman answered, but Slack refused to post the answer here. Read it in the conversation at Aflow. A reply here continues it.';

export const NOT_THE_KEY_OWNER =
  'The Slack account linked here is linked to another Aflow user than the one this app acts for, so nothing was sent. Run `yarn channel:slack setup` and link again.';

export const NO_TEXT = 'This message holds no text, so nothing was sent to the Helmsman.';

export const ENDED_NOTES: Readonly<Record<string, string>> = {
  SessionCompleted:
    'The conversation has ended. Open it at Aflow to read it, or send a new direct message to start another.',
  SessionFailed:
    'The conversation failed. Open it at Aflow to see why, or send a new direct message to start another.',
  SessionCancelled:
    'The conversation was cancelled at Aflow. Send a new direct message to start another.',
};

/**
 * Slack's limit on a message's text. The answer is measured once `&`, `<` and
 * `>` are escaped, because an escape is up to five characters long.
 */
const SLACK_TEXT_LIMIT = 40_000;
const CUT_NOTE = '… The full answer is in the conversation at Aflow.';
const WATCH_POLL_MS = 2_000;
/** How long one turn may take before the thread stops watching it. */
const WATCH_LIMIT_MS = 30 * 60 * 1000;

export type WatchOutcome = 'answered' | 'ended' | 'gave_up' | 'already_watching';

export interface ConversationResult {
  outcome: InboundOutcome | 'duplicate' | 'ignored' | 'busy_tap' | 'already_decided';
  /** The watch for the Helmsman's answer, when one started. */
  watching?: Promise<WatchOutcome>;
}

interface ConverseResult extends ConversationResult {
  outcome: InboundOutcome;
}

export interface ConversationDeps {
  store: ChannelStore;
  slack: SlackClient;
  api: AflowApi;
  /** The key's user. A conversation runs only when the link names the same one. */
  aflowUserId: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  watchLimitMs?: number;
}

/** A Slack timestamp, `seconds.micros`, in milliseconds. */
export function slackTsMs(ts: string): number | undefined {
  const seconds = Number(ts);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
}

function minutesOf(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

/** What a message run late carries, so the Helmsman reads its age before acting on it. */
export function lateText(text: string, record: InboundRecord, ranAt: Date): string {
  const waited = minutesOf(ranAt.getTime() - Date.parse(record.sentAt));
  return (
    `${text}\n\n(Sent from Slack at ${record.sentAt}. It reached Aflow late, and the operator ` +
    `chose to run it ${String(waited)} minutes after sending it.)`
  );
}

/** The answer escaped, and cut to Slack's limit between whole characters and whole escapes. */
export function relayed(answer: string): string {
  const whole = escapeMrkdwn(answer);
  if (whole.length <= SLACK_TEXT_LIMIT) return whole;
  const room = SLACK_TEXT_LIMIT - CUT_NOTE.length;
  let cut = '';
  for (const char of answer) {
    const piece = escapeMrkdwn(char);
    if (cut.length + piece.length > room) break;
    cut += piece;
  }
  return `${cut}${CUT_NOTE}`;
}

function lateBlocks(record: InboundRecord): SlackBlock[] {
  const minutes = minutesOf(record.ageMs);
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${LATE_QUESTION} It was sent ${String(minutes)} minutes before it reached the app.`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: LATE_RUN_ACTION,
          text: { type: 'plain_text', text: 'Run it now' },
          style: 'primary',
        },
        {
          type: 'button',
          action_id: LATE_DISCARD_ACTION,
          text: { type: 'plain_text', text: 'Discard' },
        },
      ],
    },
  ];
}

function refusalText(answer: RouteRefusal): string {
  const message = escapeMrkdwn(answer.message);
  if (answer.retryable && answer.outcomeUnknown) {
    return `${MAYBE_SENT} ${message} ${CHECK_AT_AFLOW}`;
  }
  if (answer.retryable) return `${NOT_SENT} ${message} Send it again.`;
  return `Aflow refused this message: ${message}`;
}

function refusalOutcome(answer: RouteRefusal): InboundOutcome {
  if (!answer.retryable) return 'refused';
  return answer.outcomeUnknown ? 'outcome_unknown' : 'not_sent';
}

const PAUSE_OR_END = new Set(['SessionPaused', ...Object.keys(ENDED_NOTES)]);

/** The newest pause or end in a page of events. */
function lastTurnEvent(events: readonly ConversationEvent[]): ConversationEvent | undefined {
  let last: ConversationEvent | undefined;
  for (const event of events) {
    if (!PAUSE_OR_END.has(event.eventType)) continue;
    if (last === undefined || Date.parse(event.timestamp) >= Date.parse(last.timestamp)) {
      last = event;
    }
  }
  return last;
}

function asksTheOperator(event: ConversationEvent): boolean {
  return event.agentResponse !== undefined || event.asksForReply;
}

/** True when Slack answered a refusal, so the post provably put nothing in the thread. */
function postedNothing(error: unknown): error is SlackApiError {
  return error instanceof SlackApiError && !error.outcomeUnknown;
}

/** What a reply finds at Aflow: a pause it may resume, an ended session, or neither. */
type OpenTurn = { kind: 'pause'; step: string } | { kind: 'ended' } | { kind: 'none' };

export class Conversations {
  private readonly watching = new Set<string>();

  constructor(private readonly deps: ConversationDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private say(channel: string, threadTs: string, text: string, blocks?: SlackBlock[]) {
    return this.deps.slack.postMessage(channel, text, {
      threadTs,
      ...(blocks === undefined ? {} : { blocks }),
    });
  }

  /**
   * Records a message from the operator before anything acts on it. Undefined
   * for an event already recorded, which then does nothing.
   */
  receive(message: DirectMessage): InboundRecord | undefined {
    const arrived = this.now();
    const sentMs = slackTsMs(message.ts) ?? arrived.getTime();
    const record: InboundRecord = {
      eventId: message.eventId,
      channel: message.channel,
      ts: message.ts,
      threadTs: message.threadTs ?? message.ts,
      sentAt: new Date(sentMs).toISOString(),
      arrivedAt: arrived.toISOString(),
      ageMs: Math.max(0, arrived.getTime() - sentMs),
      outcome: 'received',
    };
    return this.deps.store.claimInbound(record, arrived) ? record : undefined;
  }

  /** A recorded message that is not a reply to a card: held when late, else sent. */
  async answer(record: InboundRecord, wireText: string): Promise<ConversationResult> {
    const text = typedTextOf(wireText).trim();
    if (text === '') {
      await this.say(record.channel, record.threadTs, NO_TEXT);
      this.deps.store.settleInbound(record, { outcome: 'refused' });
      return { outcome: 'refused' };
    }
    if (record.ageMs > LATE_THRESHOLD_MS) {
      const question = await this.say(
        record.channel,
        record.threadTs,
        LATE_QUESTION,
        lateBlocks(record),
      );
      this.deps.store.settleInbound(record, {
        outcome: 'held_late',
        promptTs: question.ts,
        heldText: text,
      });
      return { outcome: 'held_late' };
    }
    const result = await this.converse(record, text);
    this.deps.store.settleInbound(record, { outcome: result.outcome });
    return result;
  }

  /** True when the tap is on a late message's question, which `answerLateTap` answers. */
  isLateQuestion(tap: CardTap): boolean {
    return this.deps.store.inboundAtPrompt(tap.channel, tap.messageTs) !== undefined;
  }

  /** **Run it now** or **Discard** on a late message's question. */
  async answerLateTap(tap: CardTap): Promise<ConversationResult> {
    const { store, slack } = this.deps;
    const record = store.inboundAtPrompt(tap.channel, tap.messageTs);
    if (record === undefined || store.link()?.slackUserId !== tap.slackUserId) {
      return { outcome: 'ignored' };
    }
    if (record.outcome !== 'held_late') {
      await this.say(record.channel, record.threadTs, LATE_ALREADY_DECIDED);
      return { outcome: 'already_decided' };
    }
    if (tap.actionId !== LATE_RUN_ACTION && tap.actionId !== LATE_DISCARD_ACTION) {
      return { outcome: 'ignored' };
    }
    if (!store.claimLate(record)) {
      await this.say(record.channel, record.threadTs, LATE_BUSY);
      return { outcome: 'busy_tap' };
    }
    try {
      const at = this.now();
      const text = record.heldText ?? '';
      const run = tap.actionId === LATE_RUN_ACTION;
      // The operator's choice is what §8 measures, so it stays the record's outcome.
      store.settleInbound(record, {
        outcome: run ? 'ran_late' : 'discarded',
        decidedAt: at.toISOString(),
      });
      const note = run
        ? `Run at the request of <@${tap.slackUserId}>.`
        : `Discarded by <@${tap.slackUserId}>. Nothing was sent to the Helmsman.`;
      await slack.updateMessage(record.channel, tap.messageTs, note, [
        { type: 'context', elements: [{ type: 'mrkdwn', text: `${LATE_QUESTION} ${note}` }] },
      ]);
      if (!run) return { outcome: 'discarded' };
      const result = await this.converse(record, lateText(text, record, at));
      return { ...result, outcome: 'ran_late' };
    } finally {
      store.releaseLate(record);
    }
  }

  /** Starts the conversation for the record's thread, or continues it. */
  private async converse(record: InboundRecord, text: string): Promise<ConverseResult> {
    const { store } = this.deps;
    const say = (line: string) => this.say(record.channel, record.threadTs, line);
    if (store.link()?.aflowUserId !== this.deps.aflowUserId) {
      await say(NOT_THE_KEY_OWNER);
      return { outcome: 'refused' };
    }
    const thread = store.threadAt(record.channel, record.threadTs);
    if (thread?.status === 'ended') {
      await say(CONVERSATION_ENDED);
      return { outcome: 'ended' };
    }
    // One message at a time per thread, so two replies never resume one pause.
    if (thread?.status === 'answering' || !store.claimThread(record.channel, record.threadTs)) {
      await say(STILL_ANSWERING);
      return { outcome: 'busy' };
    }
    const key = `slack-event:${record.eventId}`;
    try {
      return thread === undefined
        ? await this.start(record, text, key)
        : await this.resume(thread, text, key, say);
    } finally {
      store.releaseThread(record.channel, record.threadTs);
    }
  }

  /** Continues a waiting thread's conversation, for a reply that holds the thread's claim. */
  private async resume(
    thread: ThreadRecord,
    text: string,
    key: string,
    say: (line: string) => Promise<unknown>,
  ): Promise<ConverseResult> {
    const { store, api } = this.deps;
    let step = thread.pausedStepExecutionId ?? undefined;
    if (step === undefined) {
      const turn = await this.openTurn(thread);
      if (turn.kind === 'ended') return this.ended(thread, say);
      if (turn.kind === 'pause') step = turn.step;
    }
    if (step === undefined) {
      await say(STILL_ANSWERING);
      return { outcome: 'busy' };
    }
    const resumed = await api.resumeConversation(thread.spaceId, thread.sessionId, step, text, key);
    if (!resumed.ok && resumed.outcomeUnknown) {
      // The resume may have landed, so the thread watches for its answer as
      // for one that did, and never resumes this pause again. It is recorded
      // before the notice, so a restart watches it too.
      this.answering(thread, step);
      // Only a notice: the watch goes on when the post fails.
      await say(refusalText(resumed)).catch(() => undefined);
      return { outcome: 'outcome_unknown', watching: this.watch(thread) };
    }
    if (!resumed.ok) {
      // The next reply reads the pause again rather than trust this one. A 409
      // says the pause is closed, resumed outside this thread or moved on, so
      // the next reply skips it as one this thread resumed.
      store.updateThread(
        thread,
        {
          pausedStepExecutionId: null,
          ...(resumed.status === 409 ? { resumedStepExecutionId: step } : {}),
        },
        this.now(),
      );
      if (!resumed.retryable && (await this.openTurn(thread)).kind === 'ended') {
        return this.ended(thread, say);
      }
      await say(resumed.status === 409 ? MOVED_ON : refusalText(resumed));
      return { outcome: refusalOutcome(resumed) };
    }
    this.answering(thread, step);
    return { outcome: 'continued', watching: this.watch(thread) };
  }

  /** Records that the Helmsman answers the reply to `step`, so a watch posts a later pause only. */
  private answering(thread: ThreadRecord, step: string): void {
    this.deps.store.updateThread(
      thread,
      {
        status: 'answering',
        pausedStepExecutionId: null,
        relayedStepExecutionId: step,
        resumedStepExecutionId: step,
      },
      this.now(),
    );
  }

  /** Starts the conversation for a thread this message holds the claim on. */
  private async start(record: InboundRecord, text: string, key: string): Promise<ConverseResult> {
    const { store, api } = this.deps;
    const say = (line: string) => this.say(record.channel, record.threadTs, line);
    const home = await api.homeSpace();
    if (!home.ok) {
      await say(refusalText(home));
      return { outcome: refusalOutcome(home) };
    }
    const started = await api.startConversation(home.spaceId, text, key);
    if (!started.ok) {
      await say(refusalText(started));
      return { outcome: refusalOutcome(started) };
    }
    const at = this.now().toISOString();
    const fresh: ThreadRecord = {
      channel: record.channel,
      threadTs: record.threadTs,
      sessionId: started.sessionId,
      spaceId: home.spaceId,
      status: 'answering',
      pausedStepExecutionId: null,
      relayedStepExecutionId: null,
      resumedStepExecutionId: null,
      startedAt: at,
      updatedAt: at,
    };
    store.addThread(fresh);
    return { outcome: 'started', watching: this.watch(fresh) };
  }

  /**
   * The session's newest turn, read when the thread does not hold the pause. A
   * pause the thread already resumed is not open: the Helmsman is still
   * answering it.
   */
  private async openTurn(thread: ThreadRecord): Promise<OpenTurn> {
    const page = await this.deps.api.latestEvents(thread.spaceId, thread.sessionId);
    if (!page.ok) return { kind: 'none' };
    const last = lastTurnEvent(page.events);
    if (last === undefined) return { kind: 'none' };
    if (last.eventType !== 'SessionPaused') return { kind: 'ended' };
    const step = last.stepExecutionId;
    if (!asksTheOperator(last) || step === undefined || step === thread.resumedStepExecutionId) {
      return { kind: 'none' };
    }
    return { kind: 'pause', step };
  }

  /** Records that the session ended at Aflow, and tells the thread. */
  private async ended(
    thread: ThreadRecord,
    say: (line: string) => Promise<unknown>,
  ): Promise<ConverseResult> {
    this.deps.store.updateThread(
      thread,
      { status: 'ended', pausedStepExecutionId: null },
      this.now(),
    );
    await say(CONVERSATION_ENDED);
    return { outcome: 'ended' };
  }

  /** Watches every thread that was waiting on an answer when the app stopped. */
  resumeWatching(): Array<Promise<WatchOutcome>> {
    return this.deps.store.threadsAnswering().map((thread) => this.watch(thread));
  }

  /**
   * Watches the thread's session until it pauses with the Helmsman's answer or
   * ends, and posts what it finds into the thread. One watch per thread.
   */
  watch(thread: ThreadRecord): Promise<WatchOutcome> {
    const key = `${thread.channel}:${thread.threadTs}`;
    if (this.watching.has(key)) return Promise.resolve('already_watching');
    this.watching.add(key);
    return this.poll(thread)
      .catch((error: unknown) => {
        // A thread left answering refuses every reply until a restart watches it again.
        if (thread.status === 'answering') {
          this.deps.store.updateThread(
            thread,
            { status: 'waiting', pausedStepExecutionId: null },
            this.now(),
          );
        }
        throw error;
      })
      .finally(() => this.watching.delete(key));
  }

  private async poll(thread: ThreadRecord): Promise<WatchOutcome> {
    const { store, api } = this.deps;
    const sleep =
      this.deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    const deadline = this.now().getTime() + (this.deps.watchLimitMs ?? WATCH_LIMIT_MS);
    const say = (line: string) => this.say(thread.channel, thread.threadTs, line);
    let toldAboutAflow = false;
    for (;;) {
      const page = await api.latestEvents(thread.spaceId, thread.sessionId);
      const last = page.ok ? lastTurnEvent(page.events) : undefined;
      const ended = last === undefined ? undefined : ENDED_NOTES[last.eventType];
      if (ended !== undefined) {
        store.updateThread(thread, { status: 'ended', pausedStepExecutionId: null }, this.now());
        await say(ended);
        return 'ended';
      }
      if (
        last?.stepExecutionId !== undefined &&
        last.stepExecutionId !== thread.relayedStepExecutionId
      ) {
        const step = last.stepExecutionId;
        if (asksTheOperator(last)) {
          // Recorded before it is posted, so a restart never posts one answer twice.
          store.updateThread(
            thread,
            { status: 'waiting', pausedStepExecutionId: step, relayedStepExecutionId: step },
            this.now(),
          );
          const answer = last.agentResponse;
          await this.relay(
            thread,
            answer === undefined ? 'The Helmsman waits for your reply.' : relayed(answer),
            sleep,
          );
          return 'answered';
        }
        if (!toldAboutAflow) {
          toldAboutAflow = true;
          // Only a notice: the watch goes on to relay the answer when the post fails.
          await say(WAITS_AT_AFLOW).catch(() => undefined);
        }
      }
      if (this.now().getTime() >= deadline) {
        store.updateThread(thread, { status: 'waiting', pausedStepExecutionId: null }, this.now());
        await say(ANSWER_TAKES_LONG);
        return 'gave_up';
      }
      await sleep(this.deps.pollMs ?? WATCH_POLL_MS);
    }
  }

  /**
   * Posts the answer into the thread. A post Slack refused put nothing there,
   * so the answer is posted once more when Slack named the refusal retryable,
   * and the thread is told it was not posted when that fails too. A post that
   * may have landed is never repeated.
   */
  private async relay(
    thread: ThreadRecord,
    text: string,
    sleep: (ms: number) => Promise<void>,
  ): Promise<void> {
    const say = (line: string) => this.say(thread.channel, thread.threadTs, line);
    try {
      await say(text);
      return;
    } catch (error) {
      if (!postedNothing(error)) throw error;
      if (!error.retryable) {
        await say(ANSWER_NOT_POSTED);
        return;
      }
    }
    await sleep(this.deps.pollMs ?? WATCH_POLL_MS);
    try {
      await say(text);
    } catch (error) {
      if (!postedNothing(error)) throw error;
      await say(ANSWER_NOT_POSTED);
    }
  }
}
