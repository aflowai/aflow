'use client';

import { useCallback, useReducer, useEffect, useRef, useState } from 'react';
import { useApi } from '../components/providers.js';
import {
  useSessionEvents,
  useSessionEventListener,
  useSessionLiveDeltas,
} from './use-session-events.js';
import type { LiveDeltaFrame } from './session-events-broker.js';
import {
  runViewReducer,
  initialRunViewState,
  type Message,
  type RunViewState,
  type RunViewAction,
} from '@aflow/run-view';
import type { SessionEvent } from '../lib/types.js';

export type { RunViewState, RunViewAction };

/**
 * The most recent live frame — what the step in flight is doing right now.
 * Distinct from the reducer state because it expires by arrival time rather
 * than by any event: an activity label must go stale on its own.
 */
export interface LiveStreamActivity {
  stepExecutionId: string;
  channel: LiveDeltaFrame['channel'];
  atMs: number;
}

interface UseRunReducerReturn {
  /**
   * History exists before the page that was hydrated.
   *
   * The mount folds a bounded newest page, so what is shown is always the end
   * of the conversation and always contiguous with the live tail. This says
   * only that the conversation started earlier than the page reaches — the
   * affordance for reading back into it, not a warning that something is
   * missing from what is displayed.
   */
  hasOlder: boolean;
  /**
   * Whether reading further back can still reach more. False once the server's
   * depth ceiling answers — the edge stays, the control goes.
   */
  canLoadOlder: boolean;
  /** Read one page further back. No-op while a read is in flight or nothing is older. */
  loadOlder: () => void;
  isLoadingOlder: boolean;
  state: RunViewState;
  dispatch: React.Dispatch<RunViewAction>;
  events: SessionEvent[];
  liveActivity: LiveStreamActivity | null;
  isConnected: boolean;
  /** Force-reconnect the live session.events subscription (e.g. after retry re-opens a terminal session). */
  reconnectSSE: () => void;
  isHydrating: boolean;
}

interface SnapshotResponse {
  snapshot: RunViewState;
  tailCursor: string | null;
  olderCursor: string | null;
  hasOlder: boolean;
  foldedEventCount: number;
  catchupEventCount: number;
  status: string | null;
  catchupFailed: boolean;
}

/**
 * Live-tail startup state — drives the broker `acquire` options. Three modes:
 *
 *   - `gated`: snapshot fetch in flight; broker must not acquire yet.
 *   - `snapshot-tail`: snapshot resolved; broker subscribes with
 *     `initialCursor` and (typically) `skipCatchup: true`. When the
 *     server signals `catchupFailed: true`, `skipCatchup` is forced OFF
 *     so the `session.events` topic retries workflow-run surface synthesis.
 *   - `fallback`: snapshot fetch failed; broker acquires from the stream
 *     beginning with catch-up and ring-buffer replay ON.
 *
 * Tracking this explicitly (rather than deriving from a nullable cursor)
 * keeps the fallback path honest.
 *
 * `runId` stamps which session the state describes. State updates land one
 * render after `runId` changes, so without the stamp the render in between
 * pairs the NEW session with the OLD session's cursor — and the broker's
 * first-acquire-wins seeding makes that stale cursor stick.
 */
export type SseStartup =
  | { runId: string | null; mode: 'gated' }
  | { runId: string; mode: 'snapshot-tail'; cursor: string | null; skipCatchup: boolean }
  | { runId: string; mode: 'fallback' };

/**
 * Read the startup state for `runId`. A state stamped with a different session
 * is stale — the effect that re-gates it has not committed yet — and reads as
 * `gated` so the broker is never acquired with another session's cursor.
 */
export function sseStartupForRun(startup: SseStartup, runId: string | null): SseStartup {
  return startup.runId === runId ? startup : { runId, mode: 'gated' };
}

/**
 * Messages the server fold cannot have seen, kept across a re-hydrate.
 *
 * Reading further back re-folds the conversation from the durable log, and the
 * durable log does not carry the step that is streaming right now or a user
 * message still on its way to the orchestrator. Hydrating over them would blank
 * the answer mid-sentence; it comes back on the next frame, which reads as a
 * glitch rather than as history loading.
 *
 * Id-preserved, so React keeps the same bubbles mounted and nothing re-animates.
 */
/**
 * Whether asking for a deeper page can still yield more of the conversation.
 *
 * The server caps how deep a single fold goes and keeps reporting `hasOlder`
 * past that cap — honestly, because more history does exist. But a client that
 * takes that as an invitation asks for a deeper page, gets the same clamped one
 * back, and offers the button again: a control that reads as "more to come" and
 * does nothing, forever.
 *
 * A fold that did not grow is the ceiling answering.
 */
export function deeperPageWouldAdvance(
  previousFoldedEventCount: number | null,
  foldedEventCount: number,
): boolean {
  if (previousFoldedEventCount === null) return true;
  return foldedEventCount > previousFoldedEventCount;
}

const IN_FLIGHT_SEMANTIC_TYPES = new Set(['streaming_text', 'streaming_thinking']);

export function carryInFlightMessages(snapshot: RunViewState, previous: Message[]): RunViewState {
  const inFlight = previous.filter(
    (m) =>
      (m.semanticType !== undefined && IN_FLIGHT_SEMANTIC_TYPES.has(m.semanticType)) ||
      m.deliveryState !== undefined,
  );
  if (inFlight.length === 0) return snapshot;
  const known = new Set(snapshot.messages.map((m) => m.id));
  const extras = inFlight.filter((m) => !known.has(m.id));
  if (extras.length === 0) return snapshot;
  return { ...snapshot, messages: [...snapshot.messages, ...extras] };
}

const STEP_TERMINAL_EVENT_TYPES = new Set(['StepSucceeded', 'StepFailed', 'StepPaused']);
const SESSION_TERMINAL_EVENT_TYPES = new Set([
  'SessionCompleted',
  'SessionSucceeded',
  'SessionFailed',
  'SessionCancelled',
  'SessionPaused',
]);
const STEP_START_EVENT_TYPES = new Set(['StepScheduled', 'StepStarted']);

/**
 * Whether a durable event makes the current live preview stale: the run rested,
 * the streaming step reached a terminal, or a different step took over.
 */
export function supersedesLiveActivity(
  event: SessionEvent,
  live: LiveStreamActivity | null,
): boolean {
  if (!live) return false;
  if (SESSION_TERMINAL_EVENT_TYPES.has(event.eventType)) return true;
  const step = event.stepExecutionId;
  if (!step) return false;
  if (step === live.stepExecutionId) {
    if (!STEP_TERMINAL_EVENT_TYPES.has(event.eventType)) return false;
    // A retryable failure reuses this stepExecutionId — the retry streams
    // again, so the live preview is not yet stale.
    return !(event.eventType === 'StepFailed' && event.metadata?.['willRetry'] === true);
  }
  return STEP_START_EVENT_TYPES.has(event.eventType);
}

export function useRunReducer(runId: string | null, flowName?: string): UseRunReducerReturn {
  const { apiUrl, authFetch, headers } = useApi();

  const [state, dispatch] = useReducer(runViewReducer, initialRunViewState);
  const [liveActivity, setLiveActivity] = useState<LiveStreamActivity | null>(null);
  const liveActivityRef = useRef<LiveStreamActivity | null>(liveActivity);
  liveActivityRef.current = liveActivity;
  const processedRef = useRef<Set<string>>(new Set());

  const [sseStartup, setSseStartup] = useState<SseStartup>({ runId: null, mode: 'gated' });
  const [hasOlder, setHasOlder] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  /** False once a deeper ask came back no deeper — the server's ceiling. */
  const [canLoadOlder, setCanLoadOlder] = useState(true);

  /**
   * How many events to fold, and which session asked for it.
   *
   * Stamped with its session for the same reason `SseStartup` is: state lands
   * one render after `runId` changes, and an unstamped depth would spend that
   * render asking the NEW session for the OLD one's scroll-back — a deep read
   * nobody wanted, on the path that is supposed to open fast.
   *
   * `null` means the server's own page.
   */
  const [depthState, setDepthState] = useState<{ runId: string | null; depth: number | null }>({
    runId: null,
    depth: null,
  });
  const depth = depthState.runId === runId ? depthState.depth : null;

  /**
   * The server's page size, learned from the first response rather than
   * agreed in advance — the client has no business holding a copy of a number
   * the server picks.
   */
  const pageSizeRef = useRef<number | null>(null);
  /** Events the last accepted fold covered, for spotting one that did not grow. */
  const foldedEventCountRef = useRef<number | null>(null);

  // Keep flowName fresh inside the listener handler without resubscribing.
  const flowNameRef = useRef(flowName);
  flowNameRef.current = flowName;

  // Keep `headers` fresh inside the async fetch without re-running the
  // effect on every render (providers may rebuild the function on each
  // render; depending on it would churn the snapshot fetch).
  const headersRef = useRef(headers);
  headersRef.current = headers;

  // Pending optimistic user messages survive between effect setups (which
  // matters for React StrictMode's setup→cleanup→setup cycle, and for
  // retrying a failed snapshot fetch). Captured on the null → first-runId
  // transition (which deliberately does NOT reset, keeping the bubbles
  // mounted), then merged id-preserved into the snapshot before HYDRATE.
  // Cleared once the snapshot resolves or the fallback path commits.
  const pendingMessagesRef = useRef<Message[]>([]);

  // For the snapshot fold (which doesn't fold optimistic USER_MESSAGEs),
  // we read state.messages at the time of runId change. Need a fresh
  // reference inside the effect.
  const stateRef = useRef(state);
  stateRef.current = state;
  const prevSessionIdRef = useRef<string | null>(null);

  // What the live tail has delivered so far. Read inside the deeper-read
  // callback to replay whatever landed while it was in flight; assigned below,
  // once the subscription this hook drives has produced it.
  const eventsRef = useRef<SessionEvent[]>([]);

  useEffect(() => {
    // Treat a runId change as the "reset" boundary.
    if (runId !== prevSessionIdRef.current) {
      // Only the null → first-runId transition carries optimistic
      // messages forward: they exist only in the brief window between
      // `dispatch(USER_MESSAGE)` and the orchestrator returning the
      // runId. Subsequent runId changes (history clicks, new run from
      // a terminal one) are session switches — state.messages belongs
      // to the OLD session and must not leak onto the new snapshot.
      const carriesOptimistic = !prevSessionIdRef.current && runId != null;
      pendingMessagesRef.current = carriesOptimistic
        ? stateRef.current.messages.filter((m) => m.role === 'user')
        : [];
      // Session switches reset the view. The null → first-runId
      // transition must NOT reset: state holds only the optimistic
      // USER_MESSAGEs just captured, and a RESET unmounts those bubbles
      // for the whole snapshot fetch — a visible blank flash followed by
      // a replayed slide-in animation when they remount after HYDRATE.
      // Keeping them mounted (and merging them into the snapshot below,
      // id-preserved) keeps the React keys stable so the bubble never
      // re-animates.
      if (!carriesOptimistic) dispatch({ type: 'RESET' });
      setLiveActivity(null);
      processedRef.current.clear();
      prevSessionIdRef.current = runId;
      setSseStartup({ runId, mode: 'gated' });
      setDepthState({ runId, depth: null });
      setIsLoadingOlder(false);
      setCanLoadOlder(true);
      pageSizeRef.current = null;
      foldedEventCountRef.current = null;
    }

    if (!runId) return;

    // Always (re)start the fetch — StrictMode's setup→cleanup→setup is
    // handled because the cleanup aborts the first AbortController and
    // the second setup creates a fresh one. `pendingMessagesRef`
    // survives the cycle so optimistic messages still get merged into
    // the snapshot on HYDRATE.
    const ac = new AbortController();
    // Reading further back re-folds the conversation from one end rather than
    // stitching a page onto the last one. A message whose events straddle a
    // page boundary — an interim answer in one page, the final one in the next
    // — would otherwise be folded twice, once per page, and appear twice.
    const isDeeper = depth !== null;
    if (!isDeeper) {
      // Belongs to the session being left, not the one being opened.
      setHasOlder(false);
    }
    // Events the live tail delivers while the deeper read is in flight are not
    // in the response it returns, and hydrating over them would drop them for
    // good — the subscription has already counted them as delivered.
    const liveDeliveredBefore = eventsRef.current.length;
    void (async () => {
      try {
        const path = isDeeper
          ? `${apiUrl}/sessions/${runId}/snapshot?limit=${String(depth)}`
          : `${apiUrl}/sessions/${runId}/snapshot`;
        const res = await authFetch(path, {
          headers: headersRef.current(),
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(`Snapshot fetch failed: ${String(res.status)}`);
        const body = (await res.json()) as SnapshotResponse;
        if (ac.signal.aborted) return;
        let snapshot = body.snapshot;
        if (isDeeper) {
          snapshot = carryInFlightMessages(snapshot, stateRef.current.messages);
        } else {
          // Merge pending optimistic messages into the snapshot BEFORE the
          const pending = pendingMessagesRef.current;
          if (pending.length > 0) {
            const snapshotIds = new Set(snapshot.messages.map((m) => m.id));
            const extras = pending.filter((p) => !snapshotIds.has(p.id));
            if (extras.length > 0) {
              snapshot = { ...snapshot, messages: [...snapshot.messages, ...extras] };
            }
          }
          pendingMessagesRef.current = [];
        }
        // The page is the END of the conversation and is contiguous with the
        // live tail, so it hydrates whole. `hasOlder` says the conversation
        // started before it, which is a place to read back from rather than a
        // gap inside what is shown.
        setHasOlder(body.hasOlder);
        if (
          isDeeper &&
          !deeperPageWouldAdvance(foldedEventCountRef.current, body.foldedEventCount)
        ) {
          setCanLoadOlder(false);
        }
        foldedEventCountRef.current = body.foldedEventCount;
        if (pageSizeRef.current === null && body.foldedEventCount > 0) {
          pageSizeRef.current = body.foldedEventCount;
        }
        dispatch({ type: 'HYDRATE_SNAPSHOT', snapshot });
        if (isDeeper) {
          for (const event of eventsRef.current.slice(liveDeliveredBefore)) {
            dispatch({
              type: 'SSE_EVENT',
              event,
              ...(flowNameRef.current !== undefined ? { flowName: flowNameRef.current } : {}),
            });
          }
          setIsLoadingOlder(false);
          return;
        }
        // `catchupFailed=true` flips skipCatchup off so the topic handler's
        // workflow-run catch-up burst gets a second chance at hydrating
        // the surface state. Server-side catch-up was best-effort; this
        // is the recovery path.
        setSseStartup({
          runId,
          mode: 'snapshot-tail',
          cursor: body.tailCursor,
          skipCatchup: !body.catchupFailed,
        });
      } catch (err) {
        if (ac.signal.aborted) return;
        if (isDeeper) {
          // The conversation on screen is intact and the live tail is still
          // running — only the older page failed. Tearing the session down to
          // a stream-from-start replay would cost the reader what they already
          // had to answer a request for more.
          console.warn('[useRunReducer] older page fetch failed; keeping current view', err);
          setIsLoadingOlder(false);
          return;
        }
        // Snapshot fetch failed — fall back to stream-from-start with
        // replay history and server-side catchup. Recovery path, not a
        // parallel default. Logged so a regression in the snapshot
        // endpoint shows up.
        console.warn('[useRunReducer] snapshot fetch failed; falling back to live replay', err);
        // No re-dispatch needed: pending messages only exist on the
        // null → first-runId transition, which skips RESET — they're
        // still mounted. The live replay's SessionStarted fold dedups
        // by the round-tripped client id, so they won't double up either.
        pendingMessagesRef.current = [];
        setSseStartup({ runId, mode: 'fallback' });
      }
    })();

    return () => {
      ac.abort();
    };
  }, [runId, apiUrl, authFetch, depth]);

  const loadOlder = useCallback(() => {
    if (!hasOlder || !canLoadOlder || isLoadingOlder || runId === null) return;
    const page = pageSizeRef.current;
    if (page === null) return;
    setIsLoadingOlder(true);
    setDepthState((prev) => ({
      runId,
      depth: (prev.runId === runId ? (prev.depth ?? page) : page) + page,
    }));
  }, [hasOlder, canLoadOlder, isLoadingOlder, runId]);

  // Broker acquire is gated until the snapshot resolves OR we've committed
  // to the fallback path. Options are derived from the explicit mode so
  // the fallback genuinely gets legacy semantics (replayHistory: true,
  // skipCatchup: false) rather than a snapshot-tail variant with a
  // null cursor.
  const startup = sseStartupForRun(sseStartup, runId);
  const sseSessionId = startup.mode === 'gated' ? null : runId;
  const isSnapshotTail = startup.mode === 'snapshot-tail';
  const cursor = isSnapshotTail ? startup.cursor : null;
  const skipCatchup = isSnapshotTail ? startup.skipCatchup : false;
  const replayHistory = !isSnapshotTail;

  const { events, isConnected, reconnect } = useSessionEvents(sseSessionId, {
    initialCursor: cursor,
    skipCatchup,
  });
  eventsRef.current = events;

  useSessionEventListener(
    sseSessionId,
    (event) => {
      if (processedRef.current.has(event.eventId)) return;
      processedRef.current.add(event.eventId);
      dispatch({
        type: 'SSE_EVENT',
        event,
        ...(flowNameRef.current !== undefined ? { flowName: flowNameRef.current } : {}),
      });
      // A durable event supersedes the live preview: once the streaming step
      // ends (or a different step takes over, or the run rests), the live
      // signal is stale. Clearing it here — rather than comparing a server
      // timestamp to `Date.now()` — is what keeps the "Thinking…"/"Writing…"
      // label from freezing on a finished step under any clock skew.
      if (supersedesLiveActivity(event, liveActivityRef.current)) {
        setLiveActivity(null);
      }
    },
    {
      replayHistory,
      initialCursor: cursor,
      skipCatchup,
    },
  );

  // No dedup here, unlike the durable path above: live frames carry no id to
  // dedupe by. A reconnect re-sends the step's partial from the start, and the
  // frame's own offset is what tells the fold to replace rather than append.
  useSessionLiveDeltas(sseSessionId, (frame) => {
    dispatch({
      type: 'LIVE_DELTA',
      stepExecutionId: frame.stepExecutionId,
      channel: frame.channel,
      offset: frame.offset,
      delta: frame.delta,
      timestamp: new Date().toISOString(),
      ...(flowNameRef.current ? { senderName: flowNameRef.current } : {}),
    });
    setLiveActivity({
      stepExecutionId: frame.stepExecutionId,
      channel: frame.channel,
      atMs: Date.now(),
    });
  });

  const isHydrating = startup.mode === 'gated' && runId !== null;

  return {
    state,
    dispatch,
    hasOlder,
    canLoadOlder,
    loadOlder,
    isLoadingOlder,
    events,
    liveActivity,
    isConnected,
    reconnectSSE: reconnect,
    isHydrating,
  };
}
