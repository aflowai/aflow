'use client';

import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  Suspense,
  type ReactNode,
  type CSSProperties,
} from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { ChatLayout, EmptyState, Icon, Text, useBreakpoint } from '@aflow/design-system';
import { useApi, useSpace, useSpaceFromRoute } from '../components/providers.js';
import { CyberneticProvider } from '../components/cybernetic-provider.js';
import { AgentModelSettings } from '../components/cybernetic/AgentModelSettings.js';
import { AgentToolSettings } from '../components/cybernetic/AgentToolSettings.js';
import { SimulationChip } from '../components/cybernetic/SimulationChip.js';
import { LlmReadinessBanner } from '../components/credentials/LlmReadinessBanner.js';
import { EntityChatInspector } from '../components/entity-chat-inspector.js';
import { WorkbenchDock } from '../components/chat/WorkbenchDock.js';
import { useActionCenter } from '../hooks/use-action-center.js';
import { rehearsalRunInput } from '../lib/rehearsal.js';
import { useFlows } from '../hooks/use-flows.js';
import { useFlowDetail } from '../hooks/use-flow-detail.js';
import { useRunReducer } from '../hooks/use-run-reducer.js';
import { useActivityBubble } from '../hooks/use-activity-bubble.js';
import { deriveStagedApplet } from '@aflow/run-view';
import { useActionCenterFocus } from '../hooks/use-action-center-focus.js';
import { useHasSurface } from '../hooks/useEdition.js';
import { useVoiceSession } from '../hooks/use-voice-session.js';
import {
  ChatConversationTitle,
  ChatHeader,
  ChatInputArea,
  ChatMessages,
} from '../components/chat/index.js';
import { RoomControl } from '../components/room/RoomControl.js';
import { StagePeek, StageSplit } from '../components/room/Stage.js';
import { AgentReplyToggle } from '../components/room/AgentReplyToggle.js';
import { ViewOnlyNotice } from '../components/room/ViewOnlyNotice.js';
import { useCatchUp } from '../hooks/use-catch-up.js';
import { useRoomPost } from '../hooks/use-room-post.js';
import { useSessionPresence } from '../hooks/use-session-presence.js';
import { useCurrentUser } from '../components/user-avatar.js';
import '../components/chat/chat-entrance.css';
import { RunCompletionBanner } from '../components/chat/RunCompletionBanner.js';
import { McpElicitationCard } from '../components/chat/McpElicitationCard.js';
import { ConnectionNotice } from '../components/chat/ConnectionNotice.js';
import { SurfaceActionProvider } from '../components/surface-action-context.js';
import { ContentRenderer } from '../components/content-renderer.js';
import { HarnessActivityProvider } from '../components/harness-activity-card.js';
import { StatusOrb } from '../components/workflow-run-surface/StatusOrb.js';
import { looksLikeMarkdown } from '../lib/content-detection.js';
import { buildLiveConversationItems } from '../components/chat/conversation-items.js';
import { useChatSessionRuns } from '../components/chat/use-chat-session.js';
import { useChatRunGating } from '../components/chat/use-chat-run-gating.js';
import { useChatSubmit } from '../components/chat/use-chat-submit.js';
import type { Flow, ConversationItem, WorkflowRunSurfaceState } from '../lib/types.js';

export function ChatPage() {
  return (
    <Suspense>
      <ChatPageInner />
    </Suspense>
  );
}

function ChatPageInner() {
  const { apiUrl, headers } = useApi();
  const { activeSpace } = useSpace();
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? '';
  const searchParams = useSearchParams();
  const agentIdFromUrl = searchParams.get('agentId');
  const sessionIdFromUrl = searchParams.get('session');
  const rehearsalSim = searchParams.get('sim');
  const rehearsalPersona = searchParams.get('persona');
  const rehearsalBaseline = searchParams.get('baseline');
  const router = useRouter();
  const pathname = usePathname();
  const { isMobile } = useBreakpoint();

  const { flows, isLoading: flowsLoading } = useFlows(spaceId);
  /**
   * The world this chat is pinned to, when it was opened from a rehearsal link.
   *
   * Read every render rather than consumed once like `?draft=`: a reload before
   * the first message would otherwise drop the pin silently and the desk would
   * answer as somebody else. Once the session exists the pin lives in the run
   * and these parameters are inert.
   */
  const simulationRunInput = useMemo(
    () =>
      rehearsalRunInput({
        sim: rehearsalSim,
        persona: rehearsalPersona,
        baseline: rehearsalBaseline,
      }),
    [rehearsalSim, rehearsalPersona, rehearsalBaseline],
  );

  const [selectedFlow, setSelectedFlow] = useState<Flow | null>(null);
  const { flowDetail } = useFlowDetail(spaceId, selectedFlow?.agentId ?? null);

  const [pastItems, setPastItems] = useState<ConversationItem[]>([]);
  const [pastWorkflowRuns, setPastWorkflowRuns] = useState<Record<string, WorkflowRunSurfaceState>>(
    {},
  );
  const [dismissedElicitations, setDismissedElicitations] = useState<Set<string>>(new Set());

  const clearConversation = useCallback(() => {
    setPastItems([]);
    setPastWorkflowRuns({});
    setDismissedElicitations(new Set());
  }, []);

  const onUrlSessionAdopted = useCallback(() => {
    clearConversation();
  }, [clearConversation]);

  const { currentRun, setCurrentRun, urlSessionPending, urlSessionFailed } = useChatSessionRuns(
    selectedFlow,
    spaceId,
    sessionIdFromUrl,
    {
      autoResumeLatest: false,
      onUrlSessionAdopted,
    },
  );

  /**
   * The session to open, taken from the URL when there is one.
   *
   * `currentRun` only resolves after the agent list loads, an agent is
   * selected, and that agent's ten most recent sessions come back — so a deep
   * link, which already names the session, waited on three rounds of requests
   * before asking for the one thing it came for. Measured cold, the snapshot
   * request left at 6.9s against a first paint at 1.5s.
   *
   * The URL id is dropped only once it is known to be unresolvable, so a
   * failed deep link does not keep being fetched, and a resolved `currentRun`
   * still drives everything after adoption.
   */
  const activeSessionId = urlSessionFailed
    ? (currentRun?.sessionId ?? null)
    : (sessionIdFromUrl ?? currentRun?.sessionId ?? null);

  const hasResolvedRunRef = useRef(false);
  useEffect(() => {
    const desired = currentRun?.sessionId ?? null;
    if (desired) hasResolvedRunRef.current = true;
    const current = sessionIdFromUrl;
    if (desired === current) return;
    // A `?session=` navigation is in flight (deep link, back/forward,
    // Workbench "recent conversations"): the session hook adopts the URL's
    // session; rewriting the URL from state here would revert the
    // navigation.
    if (urlSessionPending) return;
    // Only sync the URL *down* to "no session" once we've resolved a run at
    // least once — never during the cold-mount window where `currentRun` is
    // still null because agents are loading. Exception: a known-unresolvable
    // `?session=` must be deleted even on a cold mount, or the dead param
    // sticks forever.
    if (!desired && !hasResolvedRunRef.current && !urlSessionFailed) return;
    const params = new URLSearchParams(searchParams.toString());
    if (desired) params.set('session', desired);
    else params.delete('session');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [
    currentRun?.sessionId,
    sessionIdFromUrl,
    urlSessionPending,
    urlSessionFailed,
    pathname,
    router,
    searchParams,
  ]);
  // One flag owns the companion's visibility on every breakpoint. Landing is
  // always Chat; the greeting link, header toggle, and attention badges open it.
  const [consoleOpen, setConsoleOpen] = useState(false);
  // One at a time: two agent panels open together would each hold their own
  // copy of the directives and the slower save would overwrite the other's.
  const [openSettingsPanel, setOpenSettingsPanel] = useState<
    'models' | 'tools' | 'simulation' | null
  >(null);
  const [optimisticThinking, setOptimisticThinking] = useState<string | undefined>(undefined);
  const [composerSeed, setComposerSeed] = useState<{ value: string; nonce: number }>({
    value: '',
    nonce: 0,
  });
  // Bumped to pull the companion onto the Workbench tab — an approval parked
  // while the operator sits on another tab is otherwise unreachable without
  // them knowing to go looking.
  const [workbenchFocus, setWorkbenchFocus] = useState(0);

  // `?workbench=1` (the global bell, workbench deep links) opens the
  // companion once, then drops out of the URL so reloads land on Chat.
  useEffect(() => {
    if (!searchParams.get('workbench')) return;
    setConsoleOpen(true);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('workbench');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
    // Mount-only by design: consume once from the arrival URL.
  }, []);

  // `?draft=` seeds the composer once (onboarding prompt chips, deep links),
  // then drops out of the URL so reloads don't re-seed.
  useEffect(() => {
    const draft = searchParams.get('draft');
    if (!draft) return;
    setComposerSeed((prev) => ({ value: draft, nonce: prev.nonce + 1 }));
    const params = new URLSearchParams(searchParams.toString());
    params.delete('draft');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
    // Mount-only by design: seed once from the arrival URL.
  }, []);
  const workbenchAc = useActionCenter(spaceId || null);
  const attentionBadge = workbenchAc.counts.actionable;

  const {
    state: reducerState,
    dispatch,
    events,
    liveActivity,
    isConnected: sseConnected,
    reconnectSSE,
    isHydrating,
    hasOlder,
    canLoadOlder,
    loadOlder,
    isLoadingOlder,
  } = useRunReducer(activeSessionId, selectedFlow?.name);

  const currentUser = useCurrentUser();
  const presence = useSessionPresence(currentRun?.sessionId ?? null);
  const catchUp = useCatchUp(currentRun?.sessionId ?? null);
  const { post: postToRoom } = useRoomPost(currentRun?.sessionId ?? null, spaceId);
  // Viewers see everything in the space and can steer nothing (D1). The
  // composer must not offer a send the server will refuse.
  const isViewer = activeSpace?.myRole === 'viewer';

  useActionCenterFocus(activeSpace?.id ?? null, (msg) => {
    console.info(`[action-center-focus] dispatching INLINE_PROPOSAL_FOCUS itemId=${msg.itemId}`);
    dispatch({
      type: 'INLINE_PROPOSAL_FOCUS',
      itemId: msg.itemId,
      ...(msg.reason ? { reason: msg.reason } : {}),
      timestamp: new Date(msg.ts).toISOString(),
    });
  });

  const {
    effectiveStatus,
    effectiveRequiredInput,
    hasLiveWorkflowSurface,
    isDelegatingToWorkflow,
    isTerminalStatus,
    canSend,
    isRunActive,
    isFailed,
  } = useChatRunGating({
    reducerStatus: reducerState.status,
    reducerRequiredInput: reducerState.requiredInput,
    reducerBlockedOn: reducerState.blockedOn,
    isHydrating,
    hasSession: currentRun != null,
    selectedFlow,
  });

  const [draftInvitees, setDraftInvitees] = useState<string[]>([]);
  const {
    handleSubmit,
    cancelRun,
    pauseRun,
    retryRun,
    cancelQueuedSend,
    queuedMessageId,
    isSubmitting,
    isInterrupting,
    setIsInterrupting,
  } = useChatSubmit({
    selectedFlow,
    spaceId,
    currentRun,
    setCurrentRun,
    effectiveStatus,
    effectiveRequiredInput,
    blockedOn: reducerState.blockedOn,
    isTerminalStatus,
    dispatch,
    reconnectSSE,
    reducerState,
    setPastItems,
    setPastWorkflowRuns,
    setOptimisticThinking,
    draftInvitees,
    simulationRunInput,
  });

  useEffect(() => {
    if (effectiveStatus !== 'RUNNING' && effectiveStatus !== 'QUEUED') {
      setIsInterrupting(false);
    }
  }, [effectiveStatus, setIsInterrupting]);

  // Voice is served by `/voice/token`, which only the enterprise edition
  // composes, so an edition without that surface offers no voice control at
  // all. Withholding the props is also what keeps the session dormant: the
  // hook holds idle state and reaches the network only once `connect` is
  // called, and nothing can call it once the control is gone.
  const hasVoiceSurface = useHasSurface('voice');

  const voice = useVoiceSession({
    apiUrl,
    headers,
    agentId: selectedFlow?.agentId ?? '',
    currentRunId: currentRun?.sessionId,
    resumeStepExecutionId: effectiveRequiredInput?.stepExecutionId,
    onRunStarted: useCallback(
      (sessionId: string) => {
        setCurrentRun((prev) => {
          if (prev?.sessionId === sessionId) return prev;
          return {
            sessionId,
            agentId: selectedFlow?.agentId ?? '',
            agentVersion: selectedFlow?.latestVersion ?? '',
            createdAt: new Date().toISOString(),
          };
        });
      },
      [selectedFlow, setCurrentRun],
    ),
  });

  const { activity } = useActivityBubble(currentRun?.sessionId ?? null, {
    events,
    liveDelta: liveActivity,
    runStatus: effectiveStatus ?? undefined,
    optimisticLabel: optimisticThinking,
  });
  const effectiveActivity = hasLiveWorkflowSurface ? null : activity;

  const allWorkflowRuns = useMemo(
    () => ({ ...pastWorkflowRuns, ...reducerState.workflowRuns }),
    [pastWorkflowRuns, reducerState.workflowRuns],
  );

  // Re-resolve whenever the URL names a DIFFERENT agent, not only on the first
  // resolution. Guarding on `!selectedFlow` meant a switch from the Workbench
  // pushed the new agentId, found a flow already selected, and did nothing —
  // so the URL said one agent while the composer still talked to the previous
  // one, and only a reload agreed with the address bar.
  useEffect(() => {
    if (!agentIdFromUrl || flows.length === 0) return;
    if (selectedFlow?.agentId === agentIdFromUrl) return;
    const match = flows.find((f) => f.agentId === agentIdFromUrl);
    if (!match) return;
    setSelectedFlow(match);
    // A session belongs to the agent that started it, so switching who is
    // answering starts a new one rather than continuing somebody else's.
    if (!sessionIdFromUrl) {
      setCurrentRun(null);
      clearConversation();
    }
  }, [agentIdFromUrl, flows, selectedFlow, sessionIdFromUrl, clearConversation, setCurrentRun]);

  useEffect(() => {
    if (selectedFlow || agentIdFromUrl || flows.length === 0) return;
    const defaultAgentId = activeSpace?.defaultAgentId;
    const defaultCandidate = defaultAgentId
      ? flows.find((f) => f.agentId === defaultAgentId)
      : flows.find((f) => f.systemRole === 'cybernetic-helmsman');
    if (defaultCandidate) {
      setSelectedFlow(defaultCandidate);
    }
  }, [activeSpace?.defaultAgentId, flows, selectedFlow, agentIdFromUrl]);

  const allItems = useMemo(
    () =>
      buildLiveConversationItems({
        pastItems,
        reducer: reducerState,
        isTerminalStatus,
        currentRun,
        effectiveStatus,
      }),
    [
      pastItems,
      reducerState.messages,
      reducerState.errorMessage,
      reducerState.errorDetail,
      reducerState.workflowSurfaceItems,
      reducerState.inlineItems,
      isTerminalStatus,
      currentRun,
      effectiveStatus,
    ],
  );

  // Chat always resolves to a default agent (URL agent, the space default,
  // else Helmsman) — it never asks the user to pick a "flow". While that
  // resolution is in flight we hold a calm placeholder instead of a picker.
  const helmsmanFlow = useMemo(
    () => flows.find((f) => f.systemRole === 'cybernetic-helmsman'),
    [flows],
  );
  const flowWillResolve = useMemo(() => {
    if (agentIdFromUrl) return flows.some((f) => f.agentId === agentIdFromUrl);
    const defaultAgentId = activeSpace?.defaultAgentId;
    if (defaultAgentId && flows.some((f) => f.agentId === defaultAgentId)) return true;
    return Boolean(helmsmanFlow);
  }, [agentIdFromUrl, flows, activeSpace?.defaultAgentId, helmsmanFlow]);
  const resolvingFlow = !selectedFlow && (flowsLoading || flowWillResolve);
  const isHelmsmanFlow = selectedFlow?.systemRole === 'cybernetic-helmsman';
  // A conversation the URL already names is not an empty chat — it is a full
  // one that has not arrived. Saying otherwise puts the "start a conversation"
  // states in front of it and then deletes them when it lands.
  const openingNamedSession = sessionIdFromUrl !== null;
  const emptyChat = allItems.length === 0 && !currentRun && !openingNamedSession;

  // The stage: the object the room is gathered around, derived from the same
  // items every participant folds — no state, everyone converges.
  const stagedApplet = useMemo(() => deriveStagedApplet(allItems), [allItems]);
  const greetingReady = !!selectedFlow && isHelmsmanFlow && emptyChat;
  // One persistent orb block spans the resolving placeholder and the resolved
  // Helmsman greeting, so the entrance plays once and the orb never remounts.
  // The greeting text is always rendered (it reserves its vertical space) and
  // only fades its opacity in when ready — otherwise adding the text would
  // re-center the orb and make it jump.
  // Never over a named session. The orb is the invitation to start a
  // conversation, so on a deep link it paints the wrong thing and then has to
  // be replaced — measured as the mount's largest shift cluster, and as the LCP
  // element, on a session that had 60 messages waiting behind it.
  const showHelmsmanOrb = !openingNamedSession && (resolvingFlow || greetingReady);

  const centeredOrbStyle: CSSProperties = {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-4)',
    padding: 'var(--space-6)',
    textAlign: 'center',
    color: 'var(--color-content-primary)',
  };

  const startNewRun = useCallback(() => {
    setCurrentRun(null);
    setDraftInvitees([]);
    clearConversation();
    const params = new URLSearchParams(searchParams.toString());
    params.delete('session');
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }, [clearConversation, setCurrentRun, pathname, router, searchParams]);

  // On a phone the Workbench is a mode rather than a side pane, so any tap
  // that is really "go to this chat" has to bring the chat back into view
  // or the tap looks inert (session still switches behind the board).
  const revealChat = useCallback(() => {
    if (isMobile) setConsoleOpen(false);
  }, [isMobile]);

  const startNewChat = useCallback(() => {
    revealChat();
    startNewRun();
  }, [revealChat, startNewRun]);

  // Workbench quick-starts prefill the composer + drop to a fresh chat.
  const seedComposer = useCallback(
    (text: string) => {
      revealChat();
      startNewRun();
      setComposerSeed((s) => ({ value: text, nonce: s.nonce + 1 }));
    },
    [revealChat, startNewRun],
  );

  const terminalBanner =
    isTerminalStatus && currentRun ? (
      <RunCompletionBanner
        status={effectiveStatus ?? 'SUCCEEDED'}
        errorMessage={reducerState.errorMessage}
        errorDetail={reducerState.errorDetail}
        userError={reducerState.userError}
        onRetry={isFailed ? () => void retryRun() : undefined}
        onStartNewRun={startNewRun}
        onInspect={() => {
          setConsoleOpen(true);
        }}
      />
    ) : null;

  const visibleElicitations = useMemo(
    () =>
      Object.values(reducerState.mcpElicitations).filter(
        (e) => !dismissedElicitations.has(e.elicitationId),
      ),
    [reducerState.mcpElicitations, dismissedElicitations],
  );

  const elicitationCards =
    currentRun && visibleElicitations.length > 0 ? (
      <>
        {visibleElicitations.map((entry) => (
          <McpElicitationCard
            key={entry.elicitationId}
            entry={entry}
            sessionId={currentRun.sessionId}
            onDismiss={(id) => {
              setDismissedElicitations((prev) => {
                if (prev.has(id)) return prev;
                const next = new Set(prev);
                next.add(id);
                return next;
              });
            }}
          />
        ))}
      </>
    ) : null;

  // Talking and steering are different acts, so the composer offers whichever
  // one the room is in a state for. At rest, sending steers — exactly today's
  // behaviour, which is what keeps a solo space unchanged. While the agent
  // works, sending speaks into the room instead of being refused; the agent
  // reads it at its next turn.
  // Not merely "cannot steer": while the snapshot is still loading the status
  // is unknown, and offering to post there would turn an answer the run is
  // waiting for into a message that leaves it paused forever.
  const canPostToRoom = currentRun != null && !isViewer && !canSend && !isHydrating;
  // Talking at rest without steering, for when the team is working something
  // out before anyone says go. Only offered once someone else is here — alone,
  // there is nobody to deliberate with.
  const hasCompany = presence.participants.some((p) => p.userId !== currentUser?.userId);
  // The agent answers unless someone deliberately leaves it out, and only
  // once there is somebody else here to talk to instead.
  const [agentReplies, setAgentReplies] = useState(true);
  const talkingOnly = !agentReplies && hasCompany;

  const onComposerSubmit = useCallback(
    async (content: string, config?: Record<string, unknown>) => {
      const postOnly = canPostToRoom || (canSend && talkingOnly && currentRun != null);
      if (canSend && !talkingOnly) {
        await handleSubmit(content, config);
        return;
      }
      if (!postOnly) return;
      const clientMessageId = crypto.randomUUID();
      dispatch({
        type: 'USER_MESSAGE',
        content,
        id: clientMessageId,
        timestamp: new Date().toISOString(),
      });
      // With the reply toggle showing and left on, the sender expects an
      // answer, so a post into a resting room wakes the agent. Solo rooms
      // never show the toggle and never wake — posting there stays exactly
      // the quiet drop-a-note it has always been.
      await postToRoom(content, clientMessageId, hasCompany && agentReplies);
    },
    [
      canSend,
      canPostToRoom,
      talkingOnly,
      hasCompany,
      agentReplies,
      currentRun,
      handleSubmit,
      postToRoom,
      dispatch,
    ],
  );

  const composer = (
    <ChatInputArea
      onSubmit={(content) => {
        void onComposerSubmit(content);
      }}
      sendModeControl={
        hasCompany && !isViewer ? (
          <AgentReplyToggle agentReplies={agentReplies} onChange={setAgentReplies} />
        ) : undefined
      }
      onTyping={presence.reportTyping}
      loading={isSubmitting}
      disabled={isViewer || (!canSend && !canPostToRoom)}
      runStatus={effectiveStatus}
      isRunActive={isRunActive}
      delegatingToWorkflow={isDelegatingToWorkflow}
      primaryInput={flowDetail?.primaryInput}
      onCancelRun={() => {
        if (isDelegatingToWorkflow) void pauseRun();
        else void cancelRun();
      }}
      isInterrupting={isInterrupting}
      showRunInspector={consoleOpen}
      hasCurrentRun
      showInspectorToggle={false}
      onToggleRunInspector={() => {
        setConsoleOpen((o) => !o);
      }}
      {...(hasVoiceSurface
        ? {
            voiceState: voice.state,
            voiceIsSpeaking: voice.isSpeaking,
            voiceError: voice.error,
            ...(selectedFlow ? { onVoiceConnect: () => void voice.connect() } : {}),
            onVoiceDisconnect: voice.disconnect,
            voiceMicMode: voice.micMode,
            onVoiceMicModeChange: voice.setMicMode,
            onVoiceMicToggle: voice.setMicEnabled,
            voiceMicEnabled: voice.micEnabled,
          }
        : {})}
      responseOptions={
        effectiveStatus === 'PAUSED' ? effectiveRequiredInput?.responseOptions : undefined
      }
      agentSettings={
        spaceId
          ? (variant) => (
              <>
                <AgentModelSettings
                  spaceId={spaceId}
                  open={openSettingsPanel === 'models'}
                  onOpenChange={(next) => {
                    setOpenSettingsPanel(next ? 'models' : null);
                  }}
                  variant={variant}
                />
                <AgentToolSettings
                  spaceId={spaceId}
                  open={openSettingsPanel === 'tools'}
                  onOpenChange={(next) => {
                    setOpenSettingsPanel(next ? 'tools' : null);
                  }}
                  variant={variant}
                />
                {/* Only for a chat opened as a rehearsal. Every other chat
                    renders nothing and issues no query — the parameter is
                    simply not there. */}
                {rehearsalSim && rehearsalPersona && (
                  <SimulationChip
                    spaceId={spaceId}
                    spaceSlug={routeSpace?.slug}
                    simulationId={rehearsalSim}
                    personaId={rehearsalPersona}
                    baselineVersion={rehearsalBaseline}
                    open={openSettingsPanel === 'simulation'}
                    onOpenChange={(next) => {
                      setOpenSettingsPanel(next ? 'simulation' : null);
                    }}
                    variant={variant}
                  />
                )}
              </>
            )
          : undefined
      }
      seedValue={composerSeed.value}
      seedNonce={composerSeed.nonce}
    />
  );

  const trimmedEmptyChatFlowDesc = selectedFlow?.description?.trim() ?? '';
  const emptyChatDescriptionIsMarkdown =
    trimmedEmptyChatFlowDesc.length > 0 && looksLikeMarkdown(trimmedEmptyChatFlowDesc);

  const emptyChatDescription = trimmedEmptyChatFlowDesc
    ? emptyChatDescriptionIsMarkdown
      ? undefined
      : trimmedEmptyChatFlowDesc
    : 'Send a message to start a new run';

  const chatHeaderEl = (
    <ChatHeader
      consoleOpen={consoleOpen}
      onConsoleOpenChange={setConsoleOpen}
      consoleAvailable
      consoleBadge={attentionBadge}
      {...(emptyChat ? {} : { onNewChat: startNewChat })}
      {...(currentRun?.sessionId
        ? {
            // Passed only once there is a conversation to name. An element that
            // renders nothing still reads as a title to the header, which then
            // draws the separator after the space name with nothing behind it.
            title: (
              <ChatConversationTitle
                spaceId={spaceId}
                sessionId={currentRun.sessionId}
                canEdit={!isViewer}
              />
            ),
          }
        : {})}
      presence={
        <RoomControl
          spaceId={spaceId}
          sessionId={currentRun?.sessionId ?? null}
          participants={presence.participants}
          draftInvitees={draftInvitees}
          onDraftInviteesChange={setDraftInvitees}
        />
      }
    />
  );

  const chatColumn = (
    <ChatLayout
      header={chatHeaderEl}
      composer={
        <>
          {/* The stage is pinned with the composer, not scrolled with the
              conversation — see StagePeek. It rides above every composer
              variant, including the view-only and terminal ones. */}
          {isMobile && stagedApplet ? (
            <StagePeek
              key={stagedApplet.instanceId}
              spaceId={spaceId ?? undefined}
              instanceId={stagedApplet.instanceId}
            />
          ) : null}
          <ConnectionNotice isConnected={sseConnected} hasSession={activeSessionId !== null} />
          {isViewer ? (
            <ViewOnlyNotice />
          ) : isTerminalStatus && !isFailed ? (
            terminalBanner
          ) : (
            <>
              {elicitationCards}
              {isFailed && terminalBanner}
              {spaceId && (
                <LlmReadinessBanner
                  spaceId={spaceId}
                  onReviewModels={() => {
                    setOpenSettingsPanel('models');
                  }}
                />
              )}
              <div className="chat-enter-composer">{composer}</div>
            </>
          )}
        </>
      }
    >
      {showHelmsmanOrb ? (
        <div className="chat-enter-center" style={centeredOrbStyle}>
          <StatusOrb kind="inert" size={120} style={{ opacity: 0.9 }} />
          <div
            className={greetingReady ? 'chat-orb-greeting is-ready' : 'chat-orb-greeting'}
            style={{ maxWidth: 460 }}
          >
            <Text variant="muted" size="sm">
              This is Helmsman, your workflow assistant — run a skill, create one, connect an
              integration, or just steer. The{' '}
              <button
                type="button"
                className="chat-orb-greeting-link"
                onClick={() => {
                  setConsoleOpen(true);
                }}
                aria-label="Open Workbench"
              >
                Workbench
              </button>{' '}
              shows what's running and what needs your attention.
            </Text>
          </div>
        </div>
      ) : !selectedFlow && !openingNamedSession ? (
        <EmptyState
          icon={<Icon name="warning" size={48} weight="thin" />}
          title="No assistant yet"
          description="This workspace doesn't have an assistant provisioned yet. If you just created it, give it a moment and refresh."
        />
      ) : selectedFlow && emptyChat ? (
        <EmptyState
          icon={<Icon name="chat" size={48} weight="thin" />}
          title={selectedFlow.name}
          {...(emptyChatDescription === undefined ? {} : { description: emptyChatDescription })}
          descriptionContent={
            trimmedEmptyChatFlowDesc && emptyChatDescriptionIsMarkdown ? (
              <div className="chat-empty-flow-md">
                <ContentRenderer content={trimmedEmptyChatFlowDesc} />
              </div>
            ) : undefined
          }
        />
      ) : (
        <SurfaceActionProvider
          runId={currentRun?.sessionId ?? null}
          stepExecutionId={effectiveRequiredInput?.stepExecutionId ?? null}
          dispatch={dispatch}
        >
          <ChatMessages
            hasOlder={hasOlder}
            onLoadOlder={loadOlder}
            canLoadOlder={canLoadOlder}
            sessionId={activeSessionId}
            isLoadingOlder={isLoadingOlder}
            seenMessageSeq={catchUp?.seenMessageSeq ?? null}
            stagedInstanceId={stagedApplet?.instanceId ?? null}
            items={allItems}
            runStatus={effectiveStatus}
            activity={effectiveActivity ?? null}
            requiredInput={effectiveRequiredInput}
            blockedOn={reducerState.blockedOn ?? null}
            onReviewApproval={() => {
              setConsoleOpen(true);
              setWorkbenchFocus((n) => n + 1);
            }}
            flowName={selectedFlow?.name}
            workflowRuns={allWorkflowRuns}
            workflowSurfaceSpaceId={activeSpace?.id ?? null}
            onWorkflowRunHydrate={(state) => {
              dispatch({ type: 'HYDRATE_WORKFLOW_RUN', state });
            }}
            onWorkflowRunStale={(runId) => {
              dispatch({ type: 'MARK_WORKFLOW_RUN_NEEDS_HYDRATION', runId });
            }}
            sseConnected={sseConnected}
            activitySuppressed={hasLiveWorkflowSurface}
            isHydrating={isHydrating}
            queuedMessageId={queuedMessageId}
            onCancelQueuedSend={cancelQueuedSend}
          />
        </SurfaceActionProvider>
      )}
    </ChatLayout>
  );

  // Desktop with a live object: the room splits — conversation keeps its
  // column and scroll, the stage holds the object still beside it.
  const mainContent =
    !isMobile && stagedApplet ? (
      <StageSplit
        main={chatColumn}
        spaceId={spaceId ?? undefined}
        instanceId={stagedApplet.instanceId}
      />
    ) : (
      chatColumn
    );

  // The provider wraps the inspector rather than the page.
  //
  // It withholds its children until the space and its directives have loaded,
  // and the only thing under this page that reads the context is the inspector
  // and its Coach subtree — so wrapping the page made a collapsed side dock a
  // gate on the conversation. The transcript, composer, presence and live tail
  // read none of it.
  const companionPane: ReactNode = (
    <CyberneticProvider spaceId={activeSpace?.id ?? ''}>
      <EntityChatInspector
        rootSessionId={currentRun?.sessionId ?? null}
        onSeed={seedComposer}
        onRevealChat={revealChat}
        {...(workbenchFocus > 0
          ? { focusTab: 'activity' as const, focusTabBumper: workbenchFocus }
          : {})}
        attentionCount={attentionBadge}
      />
    </CyberneticProvider>
  );

  // Phones: the workbench is a mode, not an overlay — the header (with the
  // Chat | Workbench toggle) stays put and the pane swaps beneath it.
  //
  // Desktop: the Workbench side dock, collapsed to its badge rail on landing
  // so a fresh chat stays chat-first.
  const shell: ReactNode = isMobile ? (
    !consoleOpen ? (
      mainContent
    ) : (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {chatHeaderEl}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {companionPane}
        </div>
      </div>
    )
  ) : (
    <WorkbenchDock
      main={mainContent}
      dock={companionPane}
      collapsed={!consoleOpen}
      onCollapsedChange={(collapsed) => {
        setConsoleOpen(!collapsed);
      }}
      badge={attentionBadge}
    />
  );

  // The harness feeds fold here and are read in two places under this page: the
  // step rows in the timeline, and the task rows of a run card — which sits in
  // the transcript, not the dock. One provider over both is what lets a single
  // card render live in either.
  return (
    <HarnessActivityProvider feeds={reducerState.harnessActivity} live={sseConnected}>
      {shell}
    </HarnessActivityProvider>
  );
}
