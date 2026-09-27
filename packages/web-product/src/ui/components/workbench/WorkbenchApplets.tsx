'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Column, Icon, Row, Text } from '@aflow/design-system';
import type { AppletInstanceSummary, InstalledAppletSummary } from '@aflow/schemas';

import { useApiQuery } from '../../hooks/useApiQuery.js';
import { formatUnread, useRoomActivity } from '../../hooks/use-room-activity.js';
import { spaceRoute } from '../../lib/space-routes.js';
import { formatAgo } from './WorkbenchRunRow.js';
import { WorkbenchEmptyRow, WorkbenchLink, WorkbenchSection } from './WorkbenchSection.js';

interface AppletsListResponse {
  applets: AppletInstanceSummary[];
  total: number;
  installed?: InstalledAppletSummary[];
}

interface AppletGroup {
  appletKey: string;
  name: string;
  instances: AppletInstanceSummary[];
}

/**
 * Applets (Plan 228 §3.3c) — the same shape as Skills, because an applet is the
 * same kind of thing: a capability the space has, plus the live things going on
 * inside it. So an installed applet is a row and its instances nest under it,
 * exactly as a skill's runs nest under the skill.
 *
 * Unlike a skill run, an instance is not something you watch to completion — it
 * is an object being worked, and the two ways to reach it are the board itself
 * (a new tab, so a look does not cost the operator their chat) and the room it is
 * bound to (in place — that is switching your main context, Plan 228 §3.4).
 */
export function WorkbenchApplets({
  spaceId,
  spaceSlug,
  onRevealChat,
}: {
  spaceId: string;
  spaceSlug: string;
  onRevealChat?: () => void;
}) {
  // Same key + path as the applets page, so the two share one cache entry. The
  // listing is active-only by default, which is the tuning this board wants:
  // what is live, not a history (Plan 228 §3.2).
  const query = useApiQuery<AppletsListResponse>({
    key: ['space', spaceId, 'applets'],
    path: '/applets?include=installed',
    spaceId,
    staleTime: 15_000,
    enabled: !!spaceId,
  });

  const groups = useMemo<AppletGroup[]>(() => {
    const instances = query.data?.applets ?? [];
    const installed = query.data?.installed ?? [];
    const byKey = new Map<string, AppletGroup>();
    for (const entry of installed) {
      byKey.set(entry.appletKey, { appletKey: entry.appletKey, name: entry.name, instances: [] });
    }
    for (const instance of instances) {
      // An instance whose definition has since been uninstalled still exists and
      // is still being worked — it gets its own row rather than disappearing.
      const group = byKey.get(instance.appletKey) ?? {
        appletKey: instance.appletKey,
        name: instance.appletKey,
        instances: [],
      };
      group.instances.push(instance);
      byKey.set(instance.appletKey, group);
    }
    return [...byKey.values()].sort(
      (a, b) =>
        b.instances.length - a.instances.length ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
  }, [query.data]);

  const roomIds = useMemo(
    () =>
      (query.data?.applets ?? [])
        .map((a) => a.boundSessionId)
        .filter((id): id is string => Boolean(id)),
    [query.data],
  );
  const activity = useRoomActivity(spaceId, roomIds);

  const empty = groups.length === 0;
  if (empty && query.isLoading) return null;

  return (
    <WorkbenchSection
      title="Applets"
      icon="squares-four"
      link={
        empty
          ? { href: spaceRoute(spaceSlug, '/store?kind=applet'), label: 'Applet store' }
          : { href: spaceRoute(spaceSlug, '/applets'), label: 'Manage' }
      }
    >
      {empty ? (
        <WorkbenchEmptyRow label="No applets yet" />
      ) : (
        <Column gap="xs">
          {groups.map((group) => (
            <AppletGroupRow
              key={group.appletKey}
              group={group}
              spaceSlug={spaceSlug}
              unreadIn={activity.unreadIn}
              {...(onRevealChat ? { onRevealChat } : {})}
            />
          ))}
        </Column>
      )}
    </WorkbenchSection>
  );
}

function AppletGroupRow({
  group,
  spaceSlug,
  unreadIn,
  onRevealChat,
}: {
  group: AppletGroup;
  spaceSlug: string;
  unreadIn: (sessionId: string | null | undefined) => number;
  onRevealChat?: () => void;
}) {
  const hasInstances = group.instances.length > 0;
  // Collapsed even when instances exist, unlike a skill: a skill auto-expands on
  // a *live run*, which is transient and wants watching, whereas an instance is
  // a standing object. Nearly every applet has some, so opening them all by
  // default just costs the board its height. The count on the row is the tell.
  const [expanded, setExpanded] = useState(false);
  const waiting = group.instances.filter((i) => i.attention?.waitingOn).length;

  return (
    <div
      style={{
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--color-surface-2)',
        overflow: 'hidden',
      }}
    >
      <Row gap="sm" align="center" style={{ padding: 'var(--space-2) var(--space-3)' }}>
        <button
          type="button"
          onClick={() => {
            setExpanded((e) => !e);
          }}
          aria-expanded={expanded}
          disabled={!hasInstances}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            flex: 1,
            minWidth: 0,
            background: 'none',
            border: 'none',
            cursor: hasInstances ? 'pointer' : 'default',
            textAlign: 'left',
            color: 'var(--color-text-primary)',
            padding: 0,
          }}
        >
          <Icon
            name="caret-right"
            size="xs"
            style={{
              flexShrink: 0,
              color: 'var(--color-content-muted)',
              opacity: hasInstances ? 1 : 0,
              transform: expanded ? 'rotate(90deg)' : 'none',
              transition:
                'transform var(--transition-duration-fast) var(--transition-timing-default)',
            }}
          />
          <Icon name="squares-four" size="sm" style={{ color: 'var(--color-content-muted)' }} />
          <Text size="sm" weight="medium" truncate>
            {group.name}
          </Text>
        </button>
        {/* Collapsing must not hide a wait, so it surfaces on the row itself. */}
        {waiting > 0 && (
          <Badge variant="paused" title={`${String(waiting)} waiting on someone`}>
            {String(waiting)}
          </Badge>
        )}
        {hasInstances ? (
          <Badge variant="running" title={`${String(group.instances.length)} live`}>
            {String(group.instances.length)}
          </Badge>
        ) : (
          <Text size="xs" variant="muted">
            Not started
          </Text>
        )}
      </Row>
      {expanded && hasInstances && (
        <Column gap="xs" style={{ padding: '0 var(--space-2) var(--space-2)' }}>
          {group.instances.map((instance) => (
            <AppletInstanceRow
              key={instance.instanceId}
              instance={instance}
              spaceSlug={spaceSlug}
              unread={unreadIn(instance.boundSessionId)}
              {...(onRevealChat ? { onRevealChat } : {})}
            />
          ))}
        </Column>
      )}
    </div>
  );
}

function AppletInstanceRow({
  instance,
  spaceSlug,
  unread,
  onRevealChat,
}: {
  instance: AppletInstanceSummary;
  spaceSlug: string;
  unread: number;
  onRevealChat?: () => void;
}) {
  const router = useRouter();
  const attention = instance.attention;

  return (
    <div
      style={{
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-surface-2)',
        padding: 'var(--space-1) var(--space-2)',
      }}
    >
      <Row gap="sm" align="center">
        <Column gap="none" style={{ flex: 1, minWidth: 0 }}>
          <Text size="xs" truncate>
            {attention?.title ?? formatAgo(instance.updatedAt)}
          </Text>
          {attention?.status ? (
            <Text size="xs" variant="muted" truncate>
              {attention.status}
            </Text>
          ) : null}
        </Column>
        {attention?.waitingOn ? (
          <Text size="xs" style={{ color: 'var(--color-warning-default)', flexShrink: 0 }}>
            Waiting on {attention.waitingOn}
          </Text>
        ) : null}
        <WorkbenchLink
          href={spaceRoute(spaceSlug, `/applets/${instance.instanceId}`)}
          label="Open"
        />
      </Row>
      {instance.boundSessionId ? (
        <button
          type="button"
          onClick={() => {
            const target = instance.boundSessionId;
            if (!target) return;
            onRevealChat?.();
            router.push(spaceRoute(spaceSlug, `/chat?session=${encodeURIComponent(target)}`));
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            width: '100%',
            padding: 'var(--space-1) 0 0',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            color: 'var(--color-content-muted)',
          }}
        >
          <Icon name="chat-dots" size="xs" />
          <Text size="xs" variant="muted">
            Open the room working this
          </Text>
          {unread > 0 ? (
            <Badge variant="accent" aria-label={`${formatUnread(unread)} unread`}>
              {formatUnread(unread)}
            </Badge>
          ) : null}
        </button>
      ) : null}
    </div>
  );
}
