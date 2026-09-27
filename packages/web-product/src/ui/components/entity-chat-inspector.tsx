'use client';

/**
 * Cybernetic Workbench pane — the chat's right dock for cybernetic spaces.
 *
 * The lead tab is the space-wide Workbench; the rest (Session timeline, Session
 * context) are scoped to the active session. The timeline leads with the root
 * session's own RunTimeline and overlays the cascade tree when delegation
 * produces child sessions. A missing cascade is normal (no delegation yet) and
 * is treated as "zero children", not an error.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Column,
  Row,
  Icon,
  Text,
  Tooltip,
  Tabs,
  TabList,
  Tab,
  TabPanel,
} from '@aflow/design-system';
import type { CascadeDetail, CascadeNode } from '@aflow/schemas';
import { useApi, useSpace } from './providers.js';
import { resolveSpaceSlug } from '../lib/space-routes.js';
import { useAutoScrollToBottom } from '../hooks/use-auto-scroll.js';
import { useConnectionNotice } from '../hooks/use-connection-notice.js';
import { useCybernetic } from './cybernetic-provider.js';
import { useSpaceEntityEvents } from '../hooks/use-space-entity-events.js';
import { Workbench } from './workbench/index.js';
import { CascadeFeed } from './cascade-feed.js';
import { CascadeSessionTimeline } from './cascade-session-timeline.js';
import { AgentChatHistory } from './chat/AgentChatHistory.js';

// "activity" = the Workbench, the day-to-day surface. "timeline" and "chat" are
// session-scoped debug views. The wire ids are load-bearing: `focusTab` names
// them from the chat page.
type InspectorTab = 'activity' | 'timeline' | 'chat';
const VALID_TABS: ReadonlySet<InspectorTab> = new Set(['activity', 'timeline', 'chat']);
const DEFAULT_TAB: InspectorTab = 'activity';

export function EntityChatInspector(props: {
  rootSessionId: string | null;
  focusTab?: InspectorTab;
  focusTabBumper?: number;
  /** Actionable Action Center items, badged on the Workbench tab. */
  attentionCount?: number;
  /** Prefill the composer + start a new chat (Workbench quick-starts). */
  onSeed?: (seed: string) => void;
  /** Phone: leave Workbench mode so the chat pane is visible after a session pick. */
  onRevealChat?: () => void;
}) {
  const { rootSessionId, focusTab, focusTabBumper, onSeed, onRevealChat, attentionCount } = props;
  const { spaceId, registerImperativeRefresh } = useCybernetic();
  const { events, isConnected } = useSpaceEntityEvents(spaceId);
  const { apiUrl, headers } = useApi();
  const { spaces, activeSpace } = useSpace();
  const spaceSlug = resolveSpaceSlug(spaces, spaceId, activeSpace);

  // The Workbench is what the pane is for; the other two answer a question the
  // operator went looking for. So opening the pane always lands on the
  // Workbench rather than resuming wherever a past debugging trip ended.
  const [tab, setTabState] = useState<InspectorTab>(focusTab ?? DEFAULT_TAB);
  useEffect(() => {
    setTabState(DEFAULT_TAB);
  }, [spaceId]);
  useEffect(() => {
    if (focusTab) setTabState(focusTab);
  }, [focusTab, focusTabBumper]);
  const setTab = useCallback((next: string) => {
    if (!VALID_TABS.has(next as InspectorTab)) return;
    setTabState(next as InspectorTab);
  }, []);

  // Live is the resting state and says nothing; only a stream that has stayed
  // down long enough to make the pane stale earns a word. The composer says the
  // same thing from the same phase, so the delay lives in one place. With no
  // space there is no stream: the broker subscribes to nothing and reports the
  // fallback, which is a drop that never happened.
  const showReconnecting = useConnectionNotice(isConnected, spaceId !== '') === 'reconnecting';

  const [cascadeDetail, setCascadeDetail] = useState<CascadeDetail | null>(null);
  const {
    scrollRef: timelineScrollRef,
    contentRef: timelineContentRef,
    onScroll: onTimelineScroll,
    isPinned: timelineIsPinned,
    scrollToBottom: scrollTimelineToBottom,
  } = useAutoScrollToBottom();

  const reloadCascade = useCallback(async () => {
    if (!rootSessionId) {
      setCascadeDetail(null);
      return;
    }
    try {
      const res = await fetch(`${apiUrl}/spaces/${spaceId}/cascades/${rootSessionId}`, {
        headers: { ...headers(), 'X-Space-ID': spaceId },
      });
      // A 404 just means "no cascade children yet" — not an error. Keep the
      // prior tree (if any) and let the root session's timeline carry the UI.
      if (!res.ok) return;
      const body = (await res.json()) as CascadeDetail;
      setCascadeDetail(body);
    } catch {
      // Network hiccup — next entity event will retry.
    }
  }, [apiUrl, headers, spaceId, rootSessionId]);

  useEffect(() => {
    void reloadCascade();
  }, [reloadCascade]);

  useEffect(() => {
    return registerImperativeRefresh(reloadCascade);
  }, [registerImperativeRefresh, reloadCascade]);

  // Refetch cascade when delegation-relevant entity events arrive.
  const lastEntityId = events[events.length - 1]?.eventId;
  useEffect(() => {
    if (!lastEntityId) return;
    const t = events[events.length - 1]?.eventType ?? '';
    if (
      t.startsWith('entity.runner.') ||
      t.startsWith('entity.procedure.') ||
      t.startsWith('entity.eval.')
    ) {
      void reloadCascade();
    }
  }, [lastEntityId, events, reloadCascade]);

  const childNodes: CascadeNode[] = cascadeDetail?.tree.children ?? [];

  return (
    <div
      style={{
        width: '100%',
        minWidth: 0,
        flex: 1,
        minHeight: 0,
        borderLeft: '1px dotted var(--color-border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRadius: 'var(--radius-2xl)',
        padding: 'var(--space-2)',
        backgroundColor: 'var(--surface-overlay-alpha)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
      }}
    >
      {/* No title bar: the tab strip already names the pane, and the control
          that opened it (the dock rail on desktop, the header's view switch on
          a phone) is the one that closes it. */}
      {/* Each panel owns its own scrolling — the Workbench in particular splits
          into a scrolling inventory and a pinned floor, which only works against
          a definite height. A scroll container here would hand it an unbounded
          one and the floor would drift down the page. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <Tabs value={tab} onChange={setTab}>
          <TabList style={{ padding: '0 var(--space-1)', flexShrink: 0 }}>
            <Tab id="activity">
              <Row gap="2" align="center" style={{ display: 'inline-flex' }}>
                <span>Workbench</span>
                {attentionCount !== undefined && attentionCount > 0 && (
                  <span
                    aria-label={`${String(attentionCount)} awaiting you`}
                    style={{
                      minWidth: 16,
                      height: 16,
                      padding: '0 4px',
                      borderRadius: 8,
                      background: 'var(--color-warning-default)',
                      color: 'var(--color-accent-bg)',
                      fontSize: 10,
                      fontWeight: 700,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {attentionCount}
                  </span>
                )}
              </Row>
            </Tab>
            <Tab id="timeline">Session timeline</Tab>
            <Tab id="chat">Session context</Tab>
            {showReconnecting && (
              <Tooltip content="Live updates dropped — retrying. What you see may be behind.">
                <Row
                  align="center"
                  gap="1"
                  role="status"
                  style={{ marginLeft: 'auto', paddingLeft: 'var(--space-2)', flexShrink: 0 }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      backgroundColor: 'var(--color-warning-default)',
                    }}
                  />
                  <Text size="xs" variant="muted">
                    Reconnecting
                  </Text>
                </Row>
              </Tooltip>
            )}
          </TabList>

          <TabPanel
            id="activity"
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              padding: 0,
            }}
          >
            <Workbench
              spaceId={spaceId}
              spaceSlug={spaceSlug ?? ''}
              {...(onSeed ? { onSeed } : {})}
              {...(onRevealChat ? { onRevealChat } : {})}
            />
          </TabPanel>

          <TabPanel
            id="timeline"
            style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 0, position: 'relative' }}
          >
            <div
              ref={timelineScrollRef}
              onScroll={onTimelineScroll}
              style={{ height: '100%', overflow: 'scroll', scrollbarWidth: 'none' }}
            >
              <Column ref={timelineContentRef} gap="md" style={{ padding: 'var(--space-1)' }}>
                {/* Session-scoped only — space-wide recents live in the
                    Workbench tab (Plan 228 §6). */}
                <Row gap="sm" align="center" wrap>
                  <Button variant="ghost" size="sm" onClick={() => void reloadCascade()}>
                    Refresh
                  </Button>
                  {childNodes.length > 0 && (
                    <Badge variant="info">
                      {childNodes.length} delegated{' '}
                      {childNodes.length === 1 ? 'session' : 'sessions'}
                    </Badge>
                  )}
                </Row>

                {!rootSessionId && (
                  <Text size="sm" variant="muted">
                    Send a message to start a session — events will appear here.
                  </Text>
                )}

                {rootSessionId && (
                  <Column gap="sm" style={{ padding: 'var(--space-2)' }}>
                    <Text size="sm" weight="medium">
                      This turn
                    </Text>
                    {/* Passive subscriber inside the chat
                        context. The chat-page's `useRunReducer` drives the SSE
                        connection with the snapshot cursor; if this timeline
                        acquired non-passively, its no-cursor acquire would race
                        the snapshot+tail flow into opening SSE with `?after=`
                        empty, replaying the full stream, and duplicating every
                        snapshot-folded message in the chat. */}
                    <CascadeSessionTimeline sessionId={rootSessionId} passive />
                  </Column>
                )}

                {childNodes.length > 0 && (
                  <Column gap="sm">
                    <Text size="sm" weight="medium">
                      Delegated sessions
                    </Text>
                    <CascadeFeed
                      spaceId={spaceId}
                      rootSessionId={rootSessionId}
                      entityWide={false}
                      cascadeDetail={cascadeDetail}
                    />
                  </Column>
                )}
              </Column>
            </div>
            {!timelineIsPinned && (
              <button
                type="button"
                onClick={scrollTimelineToBottom}
                aria-label="Scroll to latest"
                style={{
                  position: 'absolute',
                  bottom: 'var(--space-3)',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--space-1)',
                  padding: 'var(--space-1) var(--space-3)',
                  borderRadius: 'var(--radius-full)',
                  border: '1px solid var(--color-border-default)',
                  background: 'var(--color-surface-0)',
                  color: 'var(--color-text-secondary)',
                  fontSize: 'var(--font-size-xs)',
                  cursor: 'pointer',
                  boxShadow: 'var(--shadow-md)',
                }}
              >
                <Icon name="caret-down" size="sm" />
                <span>Latest</span>
              </button>
            )}
          </TabPanel>

          <TabPanel id="chat" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {rootSessionId ? (
              <AgentChatHistory runId={rootSessionId} />
            ) : (
              <Text size="sm" variant="muted">
                No active session — chat history appears when a run starts.
              </Text>
            )}
          </TabPanel>
        </Tabs>
      </div>
    </div>
  );
}
