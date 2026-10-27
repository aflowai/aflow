'use client';

/**
 * The board's side rail (Plan 322 P3.3): where a node's text lives. It reads
 * the node on demand when a card is opened — in full, the runs in flight, its
 * newest run links and its findings, each a page of the node detail — and,
 * for an open node, holds the operator's own controls (P3.2).
 */
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Badge, Button, Column, Row, Text, type BadgeVariant } from '@aflow/design-system';
import type {
  PlanBoardColumn,
  PlanNodeDetailOutput,
  PlanNodeLink,
  PlanTreeNode,
} from '@aflow/schemas';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { spaceRoute } from '../../lib/space-routes.js';
import {
  PLAN_BOARD_COLUMNS,
  phaseLabel,
  pullRequestLabel,
  runKindLabel,
  runLinkStatus,
  shortTime,
} from '../../lib/plan-board.js';
import {
  PlanNodeCloseControl,
  isClosedStatus,
  type PlanNodeChoosing,
  type PlanNodeCloser,
  type PlanNodeOpener,
} from './PlanNodeCloseControl.js';

/** Run links the rail lists before "All runs". */
export const PLAN_RAIL_RUNS = 5;
/** Findings the rail reads at once. */
export const PLAN_RAIL_FINDINGS = 50;
const ALL_RUNS_PAGE = 50;

export const RAIL_WIDTH = '360px';

const COLUMN_BADGE: Record<PlanBoardColumn, BadgeVariant> = {
  next: 'accent',
  progress: 'running',
  decide: 'warning',
  done: 'success',
  dropped: 'danger',
};

const linkStyle = { color: 'var(--color-text-link)' } as const;

export function planNodePath(spaceId: string, nodeId: string, query: string): string {
  return `/spaces/${spaceId}/plan/nodes/${nodeId}?${query}`;
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Column gap="xs" data-plan-rail-section={label}>
      <Text variant="label" size="xs">
        {label}
      </Text>
      {children}
    </Column>
  );
}

function RunLine({ link, spaceSlug }: { link: PlanNodeLink; spaceSlug: string }) {
  const status = runLinkStatus(link.label);
  return (
    <li>
      <Row gap="xs" align="center">
        <Link
          href={spaceRoute(spaceSlug, `/runs/${encodeURIComponent(link.ref)}`)}
          style={linkStyle}
        >
          {runKindLabel(link.label)}
        </Link>
        {status !== undefined && status !== 'completed' && (
          <Text size="xs" tone={status === 'failed' ? 'danger' : undefined} variant="muted">
            {status}
          </Text>
        )}
        <Text size="xs" variant="muted">
          {shortTime(link.createdAt)}
        </Text>
      </Row>
    </li>
  );
}

const listStyle = { listStyle: 'none', margin: 0, padding: 0 } as const;

/** Every run link of the node, a page at a time, newest first. */
function AllRuns({
  spaceId,
  spaceSlug,
  nodeId,
}: {
  spaceId: string;
  spaceSlug: string;
  nodeId: string;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  return (
    <Column gap="xs" data-plan-all-runs={nodeId}>
      <AllRunsPage spaceId={spaceId} spaceSlug={spaceSlug} nodeId={nodeId} />
      {cursors.map((cursor) => (
        <AllRunsPage
          key={cursor}
          spaceId={spaceId}
          spaceSlug={spaceSlug}
          nodeId={nodeId}
          cursor={cursor}
        />
      ))}
      <AllRunsMore
        spaceId={spaceId}
        nodeId={nodeId}
        cursor={cursors.at(-1)}
        onMore={(next) => {
          setCursors((held) => [...held, next]);
        }}
      />
    </Column>
  );
}

function useRunPage(spaceId: string, nodeId: string, cursor: string | undefined) {
  const query = `linkKind=run&limit=${String(ALL_RUNS_PAGE)}${
    cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : ''
  }`;
  return useApiQuery<PlanNodeDetailOutput>({
    key: ['space', spaceId, 'plan', 'node', nodeId, 'links', 'run', cursor ?? ''],
    path: planNodePath(spaceId, nodeId, query),
  });
}

function AllRunsPage({
  spaceId,
  spaceSlug,
  nodeId,
  cursor,
}: {
  spaceId: string;
  spaceSlug: string;
  nodeId: string;
  cursor?: string;
}) {
  const page = useRunPage(spaceId, nodeId, cursor);
  if (page.error) {
    return (
      <Text size="sm" tone="danger">
        {page.error.message}
      </Text>
    );
  }
  return (
    <ul style={listStyle}>
      {(page.data?.links ?? []).map((link) => (
        <RunLine key={link.ref} link={link} spaceSlug={spaceSlug} />
      ))}
    </ul>
  );
}

function AllRunsMore({
  spaceId,
  nodeId,
  cursor,
  onMore,
}: {
  spaceId: string;
  nodeId: string;
  cursor: string | undefined;
  onMore: (next: string) => void;
}) {
  // The last page read: the same query its list holds, so this reads nothing more.
  const page = useRunPage(spaceId, nodeId, cursor);
  const next = page.data?.nextCursor;
  if (next === undefined) return null;
  return (
    <Row>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          onMore(next);
        }}
      >
        More
      </Button>
    </Row>
  );
}

export interface PlanRailProps {
  node: PlanTreeNode;
  column: PlanBoardColumn;
  phase: PlanTreeNode | undefined;
  spaceId: string;
  spaceSlug: string;
  onClose: PlanNodeCloser;
  onOpen: PlanNodeOpener;
  /** The form open, if any; a card's Decide opens the rail with it open. */
  choosing: PlanNodeChoosing;
  onChoose: (choosing: PlanNodeChoosing) => void;
  onDismiss: () => void;
}

export function PlanRail({
  node,
  column,
  phase,
  spaceId,
  spaceSlug,
  onClose,
  onOpen,
  choosing,
  onChoose,
  onDismiss,
}: PlanRailProps) {
  const [allRuns, setAllRuns] = useState(false);
  // Read when the card is opened and again whenever it is, never from the
  // tree: the goal and criteria are what the operator closes it against, and
  // the revision a write is pinned to is the one they were read at.
  const detail = useApiQuery<PlanNodeDetailOutput>({
    key: ['space', spaceId, 'plan', 'node', node.nodeId],
    path: planNodePath(spaceId, node.nodeId, `linkKind=run&limit=${String(PLAN_RAIL_RUNS)}`),
    staleTime: 0,
  });
  const findings = useApiQuery<PlanNodeDetailOutput>({
    key: ['space', spaceId, 'plan', 'node', node.nodeId, 'links', 'finding'],
    path: planNodePath(
      spaceId,
      node.nodeId,
      `linkKind=finding&limit=${String(PLAN_RAIL_FINDINGS)}`,
    ),
  });
  const full = detail.data?.node;
  const columnLabel = PLAN_BOARD_COLUMNS.find((c) => c.id === column)?.label ?? column;
  const runLinks = detail.data?.links ?? [];
  const inFlight = (detail.data?.runs ?? []).filter((run) => run.nodeId === node.nodeId);
  const runsTotal = detail.data?.linksTotal ?? node.counts.runs;
  const open = !isClosedStatus(full?.status ?? node.status);

  return (
    <Column gap="md" data-plan-rail={node.nodeId} style={{ minWidth: 0 }}>
      <Row gap="xs" align="center" justify="between">
        <Row gap="xs" align="center" wrap>
          <Badge variant={COLUMN_BADGE[column]}>{columnLabel}</Badge>
          {phase !== undefined && <Badge variant="neutral">{phaseLabel(phase.title)}</Badge>}
        </Row>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Close
        </Button>
      </Row>
      <Text weight="semibold" size="lg">
        {node.title}
      </Text>
      <Row gap="xs" align="center" wrap>
        {node.pullRequest !== undefined && (
          <a href={node.pullRequest.url} target="_blank" rel="noopener noreferrer">
            <Badge variant={node.pullRequest.merged ? 'success' : 'info'}>
              {pullRequestLabel(node.pullRequest.url)}
            </Badge>
          </a>
        )}
        {node.pullRequest?.mergeSha !== undefined && (
          <Text variant="mono" size="xs">
            {node.pullRequest.mergeSha.slice(0, 7)}
          </Text>
        )}
        {node.rounds > 0 && (
          <Text size="xs" variant="muted">{`Rounds ${String(node.rounds)}`}</Text>
        )}
        {(full?.closedAt ?? node.closedAt) !== undefined && (
          <Text size="xs" variant="muted">
            {`Closed ${shortTime((full?.closedAt ?? node.closedAt)!)}`}
          </Text>
        )}
      </Row>
      {detail.error && (
        <Text size="sm" tone="danger" role="alert">
          {`This step could not be read: ${detail.error.message}`}
        </Text>
      )}
      <Section label="Goal">
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {full?.goal ?? node.goalHead}
        </Text>
      </Section>
      {full !== undefined && (
        <Section label={full.kind === 'decide' ? 'Decided when' : 'Done when'}>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {full.criteria}
          </Text>
        </Section>
      )}
      {full?.outcome !== undefined && (
        <Section label="Outcome">
          <div
            data-plan-outcome
            style={{
              border: '1px solid var(--color-border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-2)',
            }}
          >
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
              {full.outcome}
            </Text>
          </div>
        </Section>
      )}
      {(inFlight.length > 0 || runLinks.length > 0) && (
        <Section label="Runs">
          <ul style={listStyle}>
            {inFlight.map((run) => (
              <li key={run.runId}>
                <Row gap="xs" align="center">
                  <Link
                    href={spaceRoute(spaceSlug, `/runs/${encodeURIComponent(run.runId)}`)}
                    style={linkStyle}
                  >
                    {runKindLabel(run.slug)}
                  </Link>
                  <Badge variant={run.status}>{run.status}</Badge>
                  <Text size="xs" variant="muted">
                    {shortTime(run.startedAt)}
                  </Text>
                </Row>
              </li>
            ))}
          </ul>
          {allRuns ? (
            <AllRuns spaceId={spaceId} spaceSlug={spaceSlug} nodeId={node.nodeId} />
          ) : (
            <ul style={listStyle}>
              {runLinks.map((link) => (
                <RunLine key={link.ref} link={link} spaceSlug={spaceSlug} />
              ))}
            </ul>
          )}
          {!allRuns && runsTotal > runLinks.length && (
            <Row>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setAllRuns(true);
                }}
              >
                {`All runs · ${String(runsTotal)}`}
              </Button>
            </Row>
          )}
        </Section>
      )}
      {(findings.data?.links.length ?? 0) > 0 && (
        <Section label="Carried forward">
          <ul style={listStyle}>
            {findings.data?.links.map((link) => (
              <li key={link.ref}>
                <Text size="sm">{link.label ?? link.ref}</Text>
              </li>
            ))}
          </ul>
          {(findings.data?.linksTotal ?? 0) > (findings.data?.links.length ?? 0) && (
            <Text size="xs" variant="muted">
              {`${String((findings.data?.linksTotal ?? 0) - (findings.data?.links.length ?? 0))} more`}
            </Text>
          )}
        </Section>
      )}
      {open && (
        <PlanNodeCloseControl
          node={node}
          read={{ node: full, error: detail.error, refetch: detail.refetch }}
          onClose={onClose}
          onOpen={onOpen}
          choosing={choosing}
          onChoose={onChoose}
        />
      )}
    </Column>
  );
}
