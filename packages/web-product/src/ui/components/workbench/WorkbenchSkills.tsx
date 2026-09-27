'use client';

import { useMemo, useState } from 'react';
import { Badge, Column, Icon, IconButton, Row, Spinner, Text, Tooltip } from '@aflow/design-system';

import { useApiQuery } from '../../hooks/useApiQuery.js';
import { spaceRoute } from '../../lib/space-routes.js';
import type { SpaceWorkflowRunSummary } from '../../hooks/use-space-workflow-runs.js';
import { WorkbenchRunRow } from './WorkbenchRunRow.js';
import { WorkbenchEmptyRow, WorkbenchLink, WorkbenchSection } from './WorkbenchSection.js';
import { useRoomActivity } from '../../hooks/use-room-activity.js';

export interface WorkbenchSkill {
  slug: string;
  name: string;
  mode?: string;
  archivedAt?: string | null;
}

/**
 * Skills (Plan 228 §3.3) — the single home for the agent's skills **and their
 * runs** (Runner). Each skill is a row; skills with a live run float to the top
 * and auto-expand to show it. Expanding any skill lazily loads its recent runs;
 * each run expands to the live `WorkflowRunSurface`. A "Run" trigger prefills
 * the composer.
 */
export function WorkbenchSkills({
  skills,
  spaceId,
  spaceSlug,
  activeRuns,
  waitingOnByRun,
  loading,
  onRun,
  onRevealChat,
}: {
  skills: WorkbenchSkill[];
  spaceId: string;
  spaceSlug: string;
  activeRuns: SpaceWorkflowRunSummary[];
  waitingOnByRun?: Map<string, string>;
  /** Suppresses the dormant slot until we know the space is actually empty. */
  loading?: boolean;
  onRun: (skill: WorkbenchSkill) => void;
  onRevealChat?: () => void;
}) {
  const activeBySlug = useMemo(() => {
    const m = new Map<string, SpaceWorkflowRunSummary[]>();
    for (const r of activeRuns) {
      const list = m.get(r.workflowSlug) ?? [];
      list.push(r);
      m.set(r.workflowSlug, list);
    }
    return m;
  }, [activeRuns]);

  const ranked = useMemo(() => {
    return [...skills].sort((a, b) => {
      const aActive = activeBySlug.has(a.slug);
      const bActive = activeBySlug.has(b.slug);
      if (aActive !== bActive) return aActive ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [skills, activeBySlug]);

  const empty = skills.length === 0;
  if (empty && loading) return null;

  return (
    <WorkbenchSection
      title="Skills"
      icon="skill"
      // Same slot, different door: with nothing to manage yet, the useful
      // destination is where skills come from.
      link={
        empty
          ? { href: spaceRoute(spaceSlug, '/store?kind=skill'), label: 'Skill store' }
          : { href: spaceRoute(spaceSlug, '/skills'), label: 'Manage' }
      }
    >
      {empty ? (
        <WorkbenchEmptyRow label="No skills yet" />
      ) : (
        <Column gap="xs">
          {ranked.map((skill) => (
            <WorkbenchSkillRow
              key={skill.slug}
              skill={skill}
              spaceId={spaceId}
              spaceSlug={spaceSlug}
              active={activeBySlug.get(skill.slug) ?? []}
              {...(waitingOnByRun ? { waitingOnByRun } : {})}
              onRun={onRun}
              {...(onRevealChat ? { onRevealChat } : {})}
            />
          ))}
        </Column>
      )}
    </WorkbenchSection>
  );
}

function statusRank(status: string): number {
  if (status === 'paused') return 0;
  if (status === 'running') return 1;
  return 2;
}

function WorkbenchSkillRow({
  skill,
  spaceId,
  spaceSlug,
  active,
  waitingOnByRun,
  onRun,
  onRevealChat,
}: {
  skill: WorkbenchSkill;
  spaceId: string;
  spaceSlug: string;
  active: SpaceWorkflowRunSummary[];
  waitingOnByRun?: Map<string, string>;
  onRun: (skill: WorkbenchSkill) => void;
  onRevealChat?: () => void;
}) {
  const [expanded, setExpanded] = useState(active.length > 0);

  // Lazy per-skill history (active + recent), loaded on first expand.
  const runsQuery = useApiQuery<{ runs: SpaceWorkflowRunSummary[] }>({
    key: ['space', spaceId, 'workflow', skill.slug, 'runs', 'recent'],
    path: `/spaces/${spaceId}/workflows/${skill.slug}/runs?limit=8`,
    spaceId,
    staleTime: 15_000,
    enabled: expanded,
  });

  const loaded = runsQuery.data?.runs;
  const runs = useMemo(() => {
    const source = loaded && loaded.length > 0 ? loaded : active;
    return [...source].sort((a, b) => {
      const r = statusRank(a.status) - statusRank(b.status);
      return r !== 0 ? r : a.startedAt < b.startedAt ? 1 : -1;
    });
  }, [loaded, active]);

  const roomIds = useMemo(
    () => runs.map((r) => r.sessionId ?? r.rootSessionId).filter((id): id is string => Boolean(id)),
    [runs],
  );
  const activity = useRoomActivity(spaceId, roomIds);

  const pausedCount = active.filter((r) => r.status === 'paused').length;
  const runningCount = active.filter((r) => r.status === 'running').length;

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
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            flex: 1,
            minWidth: 0,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
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
              transform: expanded ? 'rotate(90deg)' : 'none',
              transition:
                'transform var(--transition-duration-fast) var(--transition-timing-default)',
            }}
          />
          <Icon name="skill" size="sm" style={{ color: 'var(--color-content-muted)' }} />
          <Text size="sm" weight="medium" truncate>
            {skill.name}
          </Text>
        </button>
        {skill.archivedAt && <Badge variant="neutral">Archived</Badge>}
        {pausedCount > 0 && (
          <Badge variant="paused" title={`${String(pausedCount)} paused`}>
            {String(pausedCount)}
          </Badge>
        )}
        {runningCount > 0 && (
          <Badge variant="running" title={`${String(runningCount)} running`}>
            {String(runningCount)}
          </Badge>
        )}
        <Tooltip content="Open skill">
          <IconButton
            icon={<Icon name="eye" size="sm" />}
            variant="ghost"
            size="sm"
            aria-label="Open skill"
            onClick={() =>
              window.open(
                spaceRoute(spaceSlug, `/skills?skill=${encodeURIComponent(skill.slug)}`),
                '_blank',
              )
            }
          />
        </Tooltip>
        <Tooltip content="Run">
          <IconButton
            icon={<Icon name="play" size="sm" weight="fill" />}
            variant="secondary"
            size="sm"
            aria-label="Run"
            onClick={() => {
              onRun(skill);
            }}
          />
        </Tooltip>
      </Row>
      {expanded && (
        <Column gap="xs" style={{ padding: '0 var(--space-2) var(--space-2)' }}>
          {runsQuery.isLoading && runs.length === 0 ? (
            <Row justify="center" style={{ padding: 'var(--space-2)' }}>
              <Spinner size="sm" label="Loading runs" />
            </Row>
          ) : runs.length === 0 ? (
            <Text size="xs" variant="muted">
              No runs yet — hit Run to start one.
            </Text>
          ) : (
            <>
              {runs.map((run) => (
                <WorkbenchRunRow
                  key={run.runId}
                  run={run}
                  spaceId={spaceId}
                  spaceSlug={spaceSlug}
                  unreadInRoom={activity.unreadIn(run.sessionId ?? run.rootSessionId)}
                  {...(waitingOnByRun?.get(run.runId)
                    ? { waitingOn: waitingOnByRun.get(run.runId) }
                    : {})}
                  {...(onRevealChat ? { onRevealChat } : {})}
                />
              ))}
              <WorkbenchLink
                href={spaceRoute(
                  spaceSlug,
                  `/skills?skill=${encodeURIComponent(skill.slug)}&tab=runs`,
                )}
                label="All runs"
              />
            </>
          )}
        </Column>
      )}
    </div>
  );
}
