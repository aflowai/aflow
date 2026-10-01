'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  ChatMessage,
  ChatMessageList,
  Text,
  Icon,
  Row,
  Spinner,
  SwapStack,
  Badge,
  useChatScroll,
} from '@aflow/design-system';
import { hueFromRunId } from '../../lib/display-utils.js';
import { humanizeToken, THINKING_CLASS_OPS } from '../../lib/op-labels.js';
import { ContentRenderer } from '../content-renderer.js';
import { WorkflowRunSurface, WorkflowRunSurfaceContainer } from '../workflow-run-surface/index.js';
import { InlineAppletCard, InlineArtifactCard, InlineSurfaceCard } from './InlineUiCards.js';
import { AwaitingApprovalNotice } from './AwaitingApprovalNotice.js';
import type { SessionBlockedOn } from '@aflow/schemas';
import { unsettledHarnessSteps } from '@aflow/run-view';
import type { WorkflowRunSurfaceState } from '../../lib/types.js';
import { UserAvatar, useCurrentUser } from '../user-avatar.js';
import { ParticipantBadge } from '../room/ParticipantBadge.js';
import type { ConversationItem, RequiredInput } from '../../lib/types.js';
import type { ActivitySignal } from '../../hooks/use-activity-bubble.js';
import { groupConversationItems } from './chat-message-grouping.js';
import { MessageWithCopy } from './MessageWithCopy.js';
import { TranscriptEntranceProvider } from './TranscriptEntranceContext.js';
import { TruncatedHistoryEdge } from '../truncated-history-edge.js';
import { MessageAuthorProvider } from './MessageAuthorContext.js';
import { UnreadDivider } from '../room/UnreadDivider.js';
import { findFirstUnread } from './findFirstUnread.js';
import { CollapsibleInterimGroup } from './InterimGroup.js';
import { HarnessStepCard, useHarnessActivityFeeds } from '../harness-activity-card.js';
import { harnessFeedStepId } from '../workflow-run-surface/workflowRunSurfaceHelpers.js';
import { RunSeparatorLine } from './RunSeparatorLine.js';
import './chat-messages.css';

const CHAT_AVATAR_SIZE = 28;

interface ChatMessagesProps {
  items: ConversationItem[];
  /**
   * The conversation started before `items` reaches. The page shown is its
   * end, and contiguous — this only says there is more behind it.
   */
  hasOlder?: boolean;
  /** Read one page further back. Omitted where older pages cannot be fetched. */
  onLoadOlder?: () => void;
  /** False once reading further back can no longer reach more. */
  canLoadOlder?: boolean;
  /**
   * Which conversation these items belong to. Changing it is what tells the
   * scroll container the content was replaced rather than extended.
   */
  sessionId?: string | null;
  /** An older page is in flight. */
  isLoadingOlder?: boolean;
  /** While an instance is on the stage, its inline cards render as chips —
   *  the picture lives on the stage, the narrative stays in the stream. */
  stagedInstanceId?: string | null;
  runStatus: string | null;
  blockedOn?: SessionBlockedOn | null;
  onReviewApproval?: (() => void) | undefined;
  activity: ActivitySignal | null;
  requiredInput: RequiredInput | null;
  /** Flow name shown as fallback in the activity row's second line */
  flowName?: string | undefined;
  workflowRuns?: Record<string, WorkflowRunSurfaceState>;
  workflowSurfaceSpaceId?: string | null;
  onWorkflowRunHydrate?: (state: WorkflowRunSurfaceState) => void;
  onWorkflowRunStale?: (runId: string) => void;
  sseConnected?: boolean;
  activitySuppressed?: boolean;
  /**
   * True while the run-view snapshot is in flight. Suppresses the legacy
   * `requiredInput.prompt` fallback below — for inline-HITL pauses the
   * REST `/sessions/{id}` response carries the prompt, but the reducer
   * clears it once the snapshot resolves (see
   * `packages/run-view/src/reducer/events/sessionLifecycle.ts`). Rendering
   * during hydration produces a brief flash of raw markdown for what is
   * about to be replaced by a proper inline-HITL message.
   */
  isHydrating?: boolean;
  queuedMessageId?: string | null;
  /**
   * Where the reader left off. The line goes above the first message past it —
   * placed here rather than named by the server, because the timeline is
   * already loaded and the server would have to search the log to name it.
   */
  seenMessageSeq?: number | null;
  onCancelQueuedSend?: () => void;
}

/**
 * Minimum on-screen time per trail line. The hook emits StepScheduled →
 * StepStarted for the same step milliseconds apart (the second often
 * enriches the detail) — without a dwell the second roll interrupts the
 * first mid-FLIP, which reads as a flash. This is animation pacing (like a
 * transition duration), and it doubles as readability: each action stays
 * legible before the next rolls in; the latest candidate wins the queue.
 */
const TRAIL_MIN_DWELL_MS = 700;

interface TrailLine {
  head: string;
  detail?: string;
  runId: string;
  /** Visible signature — identical signatures never re-roll. */
  sig: string;
}

/**
 * Rolling last-actions line under the activity label — the chat-row
 * equivalent of the workflow-run surface's `ActivitySubline`. Latches the
 * most recent SUBSTANTIVE signal (a real tool/op step, never a
 * thinking-class agent turn): line 1's label already says "Thinking…" /
 * "Writing…" during LLM phases, so this line answers "what did it just do /
 * what is it working through" instead of parroting "AI Agent Turn". Distinct
 * actions roll through a `<SwapStack>` trail (current at the bottom, recent
 * history dimming above) — proof of life plus a hint of direction.
 */
function ChatActivityTrail({
  activity,
  flowName,
}: {
  activity: ActivitySignal | null;
  flowName?: string | undefined;
}) {
  const [displayed, setDisplayed] = useState<TrailLine | null>(null);
  const displayedRef = useRef<TrailLine | null>(null);
  displayedRef.current = displayed;
  const lastPushAtMsRef = useRef(0);
  const pendingRef = useRef<TrailLine | null>(null);
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!activity) return;
    if (activity.operationId && THINKING_CLASS_OPS.has(activity.operationId)) return;
    const head =
      activity.stepName ?? (activity.operationId ? humanizeToken(activity.operationId) : undefined);
    if (!head) return;
    const candidate: TrailLine = {
      head,
      ...(activity.stepDetail ? { detail: activity.stepDetail } : {}),
      runId: activity.runId,
      sig: `${head}::${activity.stepDetail ?? ''}`,
    };
    if (displayedRef.current?.sig === candidate.sig) {
      // Already showing this line — drop any stale queued replacement.
      pendingRef.current = null;
      return;
    }
    const sinceLastMs = Date.now() - lastPushAtMsRef.current;
    if (sinceLastMs >= TRAIL_MIN_DWELL_MS) {
      lastPushAtMsRef.current = Date.now();
      pendingRef.current = null;
      setDisplayed(candidate);
      return;
    }
    // Current line hasn't had its dwell yet — queue (latest candidate wins)
    // and roll it in once the dwell elapses.
    pendingRef.current = candidate;
    if (!dwellTimerRef.current) {
      dwellTimerRef.current = setTimeout(() => {
        dwellTimerRef.current = null;
        const next = pendingRef.current;
        pendingRef.current = null;
        if (!next || displayedRef.current?.sig === next.sig) return;
        lastPushAtMsRef.current = Date.now();
        setDisplayed(next);
      }, TRAIL_MIN_DWELL_MS - sinceLastMs);
    }
  }, [activity]);

  // A latched line from a previous run must not bleed into a new run's
  // first thinking phase (the trail resets to the flow-name fallback).
  const latchValid = displayed != null && (activity == null || activity.runId === displayed.runId);
  const display = latchValid ? displayed : null;

  const head = display?.head ?? flowName;
  if (!head) return null;
  const detail = display?.detail;

  return (
    <div className="chat-activity-trail" title={detail ? `${head} · ${detail}` : head}>
      <SwapStack swapKey={`${head}::${detail ?? ''}`}>
        {head}
        {detail && <span style={{ opacity: 0.7 }}>{` · ${detail}`}</span>}
      </SwapStack>
    </div>
  );
}

/** Compact chip for surface action interactions (button clicks, form submits). */
function StagedAppletChip() {
  return (
    <div style={{ display: 'flex', padding: 'var(--space-1) var(--space-5)' }}>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-1) var(--space-3)',
          borderRadius: 'var(--radius-full)',
          backgroundColor: 'var(--color-interactive-muted)',
          fontSize: 'var(--text-xs)',
          color: 'var(--color-content-muted)',
        }}
      >
        Board updated — on the table
      </div>
    </div>
  );
}

function SurfaceActionChip({ label }: { label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        padding: 'var(--space-2) var(--space-5)',
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-1) var(--space-3)',
          borderRadius: 'var(--radius-full)',
          backgroundColor: 'var(--color-interactive-muted)',
          border: '1px solid var(--color-border-default)',
        }}
      >
        <Icon name="lightning" size="xs" />
        <Text size="sm">{label}</Text>
      </div>
    </div>
  );
}

export function ChatMessages({
  items,
  hasOlder = false,
  onLoadOlder,
  canLoadOlder = true,
  isLoadingOlder = false,
  sessionId,
  stagedInstanceId,
  runStatus,
  blockedOn,
  onReviewApproval,
  activity,
  requiredInput,
  flowName,
  workflowRuns,
  workflowSurfaceSpaceId,
  onWorkflowRunHydrate,
  onWorkflowRunStale,
  sseConnected,
  activitySuppressed,
  isHydrating,
  queuedMessageId,
  seenMessageSeq,
  onCancelQueuedSend,
}: ChatMessagesProps) {
  const user = useCurrentUser();
  const userAvatar = user ? (
    <ParticipantBadge
      name={user.displayName || 'You'}
      avatarUrl={user.avatarUrl}
      role={undefined}
      driving={false}
      overlapping={false}
      size={CHAT_AVATAR_SIZE}
    />
  ) : (
    <UserAvatar user={user} size={CHAT_AVATAR_SIZE} />
  );

  // Sticky-bottom scroll state from `ChatLayout` (it owns the scroll container).
  // Used only for the "New content" affordance — the scrolling itself happens
  // in `ChatLayout` via `useAutoScrollToBottom`.
  const { isPinned, isScrollable, scrollToBottom, captureAnchor, restoreAnchor, resetAutoScroll } =
    useChatScroll();

  // A different conversation is new content, not more of the same — so it opens
  // at its end rather than scrolling there, exactly as the first one did. This
  // layout outlives the session it shows, so nothing below it would notice.
  const prevSessionRef = useRef(sessionId);
  useLayoutEffect(() => {
    if (prevSessionRef.current === sessionId) return;
    prevSessionRef.current = sessionId;
    resetAutoScroll();
  }, [sessionId, resetAutoScroll]);

  // Older history grows the transcript ABOVE the viewport, so the reader's
  // place has to be held across the re-fold or the view jumps a page every
  // time they ask for one. Captured on the request, restored once the longer
  // list has been laid out — in a layout effect, so it happens before the
  // browser paints and the jump is never visible.
  const requestOlder = useCallback(() => {
    captureAnchor();
    onLoadOlder?.();
  }, [captureAnchor, onLoadOlder]);
  // Restored when the older page LANDS, not on any change to `items`. A live
  // message arriving while the request is in flight is also an items change,
  // and consuming the anchor on it leaves the deeper fold — the one that
  // actually grows the list above the reader — with nothing to anchor to.
  const wasLoadingOlderRef = useRef(isLoadingOlder);
  useLayoutEffect(() => {
    const landed = wasLoadingOlderRef.current && !isLoadingOlder;
    wasLoadingOlderRef.current = isLoadingOlder;
    if (landed) restoreAnchor();
  }, [isLoadingOlder, items, restoreAnchor]);

  const renderItems = useMemo(() => groupConversationItems(items), [items]);

  const firstUnread = useMemo(
    () => findFirstUnread(items, seenMessageSeq ?? null, user?.userId),
    [items, seenMessageSeq, user?.userId],
  );

  // A new user ("me") message must always pull the view to the bottom, even if
  // the user had scrolled up — sending is an explicit intent to follow along.
  // `scrollToBottom` re-pins, so subsequent streamed content keeps tracking.
  const lastUserMessageId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it?.kind === 'message' && it.message.role === 'user') return it.message.id;
    }
    return null;
  }, [items]);
  const prevUserMessageIdRef = useRef<string | null>(lastUserMessageId);
  useEffect(() => {
    if (lastUserMessageId && lastUserMessageId !== prevUserMessageIdRef.current) {
      scrollToBottom();
    }
    prevUserMessageIdRef.current = lastUserMessageId;
  }, [lastUserMessageId, scrollToBottom]);

  // A harness step commissioned from this conversation streams its feed
  // before it has a result, and until then nothing in the transcript names it.
  // Its card is shown from the feed alone until the step settles. A feed a
  // workflow run in this transcript already shows is that run's to render.
  const harnessFeeds = useHarnessActivityFeeds();
  const runningHarnessSteps = useMemo(() => {
    const shownByRuns = new Set<string>();
    for (const run of Object.values(workflowRuns ?? {})) {
      for (const task of Object.values(run.tasks)) {
        const id = harnessFeedStepId(task);
        if (id !== undefined) shownByRuns.add(id);
      }
    }
    const messages = items.flatMap((it) => (it.kind === 'message' ? [it.message] : []));
    return unsettledHarnessSteps(harnessFeeds, messages).filter((id) => !shownByRuns.has(id));
  }, [harnessFeeds, items, workflowRuns]);

  const isStreaming = items.some(
    (it) =>
      it.kind === 'message' &&
      (it.message.semanticType === 'streaming_text' ||
        it.message.semanticType === 'streaming_thinking'),
  );

  const showScrollButton = !isPinned && isScrollable && (isStreaming || runStatus === 'RUNNING');

  // Stable per-child accent for the activity row, paired to the corresponding
  // bubbles below so the eye can cluster interleaved sub-agent messages.
  const activityHue = hueFromRunId(activity?.delegateRunId);
  const activityVisible =
    !activitySuppressed && (runStatus === 'RUNNING' || runStatus === 'WAITING_ON_CHILD');
  // The sub-agent is paused waiting on input/approval — show a static "blocked"
  // affordance instead of the spinner so the row reads as waiting, not working.
  const isWaitingOnChild = runStatus === 'WAITING_ON_CHILD';
  const activityRowStyle: CSSProperties = {
    padding: 'var(--space-3) var(--space-5)',
    minHeight: 40,
    color: 'var(--color-text-muted)',
    opacity: activityVisible ? 1 : 0,
    transition: 'opacity 400ms ease-out',
    ...(activityHue != null
      ? ({ ['--chat-activity-delegate-accent']: `hsl(${String(activityHue)}, 55%, 55%)` } as Record<
          string,
          string
        >)
      : {}),
  };

  return (
    <MessageAuthorProvider>
      <TranscriptEntranceProvider itemCount={items.length}>
        <ChatMessageList>
          {/* Said plainly, because a conversation that opens at its end
              without a mark reads as the whole of it. */}
          {hasOlder && (
            <TruncatedHistoryEdge
              label={canLoadOlder ? 'Show earlier messages' : 'Earlier messages are not shown'}
              loadingLabel="Loading earlier messages…"
              loading={isLoadingOlder}
              {...(onLoadOlder && canLoadOlder ? { onLoadOlder: requestOlder } : {})}
            />
          )}
          {renderItems.map((ri) => {
            if (ri.kind === 'run-separator') {
              return <RunSeparatorLine key={ri.item.id} item={ri.item} />;
            }
            if (ri.kind === 'workflow_run_surface') {
              const cardKey = ri.anchorStepExecutionId
                ? `wfs:${ri.runId}:${ri.anchorStepExecutionId}`
                : `wfs:${ri.runId}`;
              if (ri.displaySource === 'op' && workflowSurfaceSpaceId) {
                return (
                  <WorkflowRunSurfaceContainer
                    key={cardKey}
                    runId={ri.runId}
                    spaceId={workflowSurfaceSpaceId}
                  />
                );
              }
              return (
                <WorkflowRunSurface
                  key={cardKey}
                  runId={ri.runId}
                  state={ri.frozenSnapshot ?? workflowRuns?.[ri.runId]}
                  spaceId={workflowSurfaceSpaceId ?? null}
                  onHydrate={onWorkflowRunHydrate}
                  sseConnected={sseConnected}
                  showOpenFullRun={!ri.frozenSnapshot}
                  {...(!ri.frozenSnapshot && onWorkflowRunStale
                    ? { onStaleRun: onWorkflowRunStale }
                    : {})}
                />
              );
            }
            if (ri.kind === 'interim-group') {
              return (
                <CollapsibleInterimGroup
                  key={ri.id}
                  messages={ri.messages}
                  userAvatar={userAvatar}
                  subflowSource={ri.subflowSource}
                  subflowLabel={ri.subflowLabel}
                  showSubflowHeader={ri.showSubflowHeader}
                  continuesFrom={ri.continuesFrom}
                  continuedBy={ri.continuedBy}
                />
              );
            }
            if (ri.kind === 'inline_artifact') {
              return <InlineArtifactCard key={ri.itemId} item={ri} />;
            }
            if (ri.kind === 'inline_surface') {
              return <InlineSurfaceCard key={ri.itemId} item={ri} />;
            }
            if (ri.kind === 'inline_applet') {
              if (stagedInstanceId && ri.instanceId === stagedInstanceId) {
                return <StagedAppletChip key={ri.itemId} />;
              }
              return (
                <InlineAppletCard
                  key={ri.itemId}
                  item={ri}
                  spaceId={workflowSurfaceSpaceId ?? undefined}
                />
              );
            }
            // ri.kind === 'message'
            return ri.message.id.startsWith('surface-action-') ? (
              <SurfaceActionChip key={ri.message.id} label={ri.message.content} />
            ) : (
              <Fragment key={ri.message.id}>
                {firstUnread?.id === ri.message.id ? (
                  <UnreadDivider since={firstUnread.timestamp} />
                ) : null}
                <MessageWithCopy
                  message={ri.message}
                  userAvatar={userAvatar}
                  showSubflowHeader={ri.showSubflowHeader}
                  {...(onCancelQueuedSend && queuedMessageId === ri.message.id
                    ? { onCancelQueuedSend }
                    : {})}
                />
              </Fragment>
            );
          })}
          {runningHarnessSteps.map((stepExecutionId) => (
            <div
              key={`harness:${stepExecutionId}`}
              className="chat-message-wrapper"
              data-chat-message
            >
              <HarnessStepCard stepExecutionId={stepExecutionId} running />
            </div>
          ))}
          {runStatus === 'QUEUED' && (
            <Row
              gap="2"
              style={{ padding: 'var(--space-3) var(--space-5)', color: 'var(--color-text-muted)' }}
            >
              <Spinner size="lg" />
              <Text variant="muted" size="sm">
                Connecting to agent…
              </Text>
            </Row>
          )}
          {/* Activity row — always mounted to reserve space and avoid layout shift.
          Shows spinner + label while RUNNING, empty breathing room when idle/paused.
          Hidden from assistive tech when invisible so SR users don't hear
          "Working…" during the suppressed window. */}
          <Row gap="2" align="start" style={activityRowStyle} aria-hidden={!activityVisible}>
            {isWaitingOnChild ? <Icon name="pause" size="lg" /> : <Spinner size="lg" />}
            {/* flex: 1 — the SwapStack trail's lines are absolutely positioned
            (zero intrinsic width), so the column must claim the row's
            remaining width or the trail ellipsizes after a word or two. */}
            <div
              style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: '2px' }}
            >
              <Text variant="muted" size="sm">
                {isWaitingOnChild ? 'Waiting on sub-agent' : (activity?.label ?? 'Working…')}
              </Text>
              {(activity?.delegateRole ||
                activity?.delegateAgentName ||
                activity?.delegateWorkflowSlug ||
                activity?.delegateTaskName) && (
                <Text variant="mono" size="xs" className="chat-activity-delegate">
                  {activity.delegateAgentName ??
                    (activity.delegateRole ? humanizeToken(activity.delegateRole) : 'delegate')}
                  {activity.delegateWorkflowSlug && ` · ${activity.delegateWorkflowSlug}`}
                  {activity.delegateTaskName && (
                    <span style={{ opacity: 0.7 }}>{` › ${activity.delegateTaskName}`}</span>
                  )}
                </Text>
              )}
              <ChatActivityTrail activity={activity} flowName={flowName} />
            </div>
          </Row>
          {runStatus === 'PAUSED' && !isHydrating && blockedOn?.kind === 'needs_write_approval' && (
            <AwaitingApprovalNotice block={blockedOn} onReview={onReviewApproval} />
          )}
          {runStatus === 'PAUSED' &&
            requiredInput?.prompt &&
            !requiredInput.subflowPause &&
            !isHydrating && (
              <ChatMessage role="assistant" senderName="System">
                <ContentRenderer content={requiredInput.prompt} />
              </ChatMessage>
            )}
          {(runStatus === 'PAUSED' || runStatus === 'WAITING_ON_CHILD') &&
            requiredInput &&
            requiredInput.subflowPause && (
              <div className="chat-message-wrapper--subflow">
                <div className="chat-subflow-label">
                  <Icon name="git-branch" size="xs" />
                  <Text variant="mono" size="xs">
                    {requiredInput.subflowStepName ?? 'Delegate'}
                  </Text>
                </div>
                <Row
                  gap="2"
                  style={{
                    padding: 'var(--space-3) var(--space-5)',
                    minHeight: 44,
                    color: 'var(--color-text-muted)',
                  }}
                >
                  <Badge variant="paused">Awaiting input</Badge>
                </Row>
              </div>
            )}

          {/* Scroll-to-bottom pill — shown when user scrolled up during active run */}
          {showScrollButton && (
            <button
              className="chat-scroll-to-bottom"
              onClick={scrollToBottom}
              aria-label="Scroll to latest"
            >
              <Icon name="caret-down" size="sm" />
              <span>New content</span>
            </button>
          )}
        </ChatMessageList>
      </TranscriptEntranceProvider>
    </MessageAuthorProvider>
  );
}
