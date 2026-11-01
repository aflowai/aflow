'use client';

/**
 * The side rail (Plan 322 P3.3), over a plan's board or the overview's lanes
 * (Plan 332 D8): where a node's text lives. It reads
 * the node on demand when a card is opened — in full, the runs in flight, its
 * newest run links and its findings, each a page of the node detail — with
 * **Now**, the note's first line, above the goal and the whole note folded
 * under **Working note** (Plan 332 D5), and holds the operator's own controls:
 * close an open node (P3.2), **Approve** a blocked one, **Reopen** a closed one,
 * and for a stranded one reopen the closed step above it (Plan 332 D6). A
 * blocked step's Approve carries the operator's instructions, **Revise** sends
 * them back for a rewrite, and **Discuss** opens the space chat about the step
 * (Plan 337 P4). A step with a decision card shows the card's sections above
 * its goal, and the goal folds. **Read the plan** opens the step's newest plan
 * document (Plan 337 P2). The goal, criteria, note and outcome render as
 * markdown, as their writers put them (Plan 332). It is
 * the page's inspector, headed, sectioned and set as the skill designer's is.
 */
import { useState } from 'react';
import Link from 'next/link';
import {
  Badge,
  Button,
  Column,
  Heading,
  Icon,
  IconButton,
  Row,
  Text,
  Tooltip,
  type BadgeVariant,
} from '@aflow/design-system';
import {
  PLAN_NODE_CONVERSATION_LINK_LABEL,
  type PlanBoardColumn,
  type PlanNeedsYouReason,
  type PlanNodeDetailOutput,
  type PlanNodeLink,
  type PlanTreeNode,
} from '@aflow/schemas';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { spaceRoute } from '../../lib/space-routes.js';
import {
  NEEDS_YOU_REASON_LABEL,
  PLAN_BOARD_COLUMNS,
  phaseLabel,
  planDetailRailNode,
  reviewRoundsLabel,
  runKindLabel,
  runLinkStatus,
  shortTime,
} from '../../lib/plan-board.js';
import {
  PlanNodeCloseControl,
  isClosedStatus,
  type PlanNodeCloser,
  type PlanNodeRead,
} from './PlanNodeCloseControl.js';
import {
  PlanNodeOpenControl,
  type PlanNodeOpener,
  type PlanNodeReviser,
} from './PlanNodeOpenControl.js';
import {
  NextMarker,
  PLAN_ORB_SIZE,
  PlanRunLine,
  PlanStepOrb,
  PullRequestChip,
  RailMarkdown,
  RailSection,
  railProse,
} from './PlanParts.js';
import { PlanCardSections } from './PlanCardSections.js';
import { planDocumentTarget } from '../../lib/plan-card.js';

/** Run links the rail lists before "All runs". */
export const PLAN_RAIL_RUNS = 5;
/** Findings the rail reads at once. */
export const PLAN_RAIL_FINDINGS = 50;
/** Conversations about the step the rail lists, newest first. */
export const PLAN_RAIL_CONVERSATIONS = 5;

/**
 * The first message of a conversation about one step (Plan 337 P4): its title
 * and id, so the Helmsman opens the node it is asked about. The operator
 * writes the rest.
 */
export function planDiscussDraft(node: { nodeId: string; title: string }): string {
  return `About the plan step "${node.title}" (node ${node.nodeId}). Open it with plan.node.get before you answer.\n\n`;
}
const ALL_RUNS_PAGE = 50;

const COLUMN_BADGE: Record<PlanBoardColumn, BadgeVariant> = {
  needs_you: 'warning',
  in_flight: 'running',
  up_next: 'accent',
  done: 'success',
  dropped: 'danger',
};

const linkStyle = { color: 'var(--color-text-link)' } as const;

export function planNodePath(spaceId: string, nodeId: string, query: string): string {
  return `/spaces/${spaceId}/plan/nodes/${nodeId}?${query}`;
}

/** The rail's own dismiss, a quiet icon in its corner. */
function RailDismiss({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Tooltip content="Close" side="left">
      <IconButton
        size="sm"
        variant="ghost"
        aria-label="Close"
        icon={<Icon name="x" size={14} weight="bold" />}
        onClick={onDismiss}
      />
    </Tooltip>
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

/**
 * **Read the plan** (Plan 337 D2): the newest document link's ref. A URL
 * opens in a new tab. A path and a sha, from a folder with no remote, show as
 * text to copy.
 */
function ReadThePlan({ documentRef }: { documentRef: string }) {
  const target = planDocumentTarget(documentRef);
  return (
    <Row gap="xs" align="center" wrap data-plan-document>
      {'href' in target ? (
        <a href={target.href} target="_blank" rel="noopener noreferrer" style={linkStyle}>
          Read the plan
        </a>
      ) : (
        <>
          <Text size="sm" weight="medium">
            Read the plan:
          </Text>
          <Text variant="mono" size="xs" data-plan-document-ref>
            {target.text}
          </Text>
        </>
      )}
    </Row>
  );
}

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

/**
 * Only the read a rail made on opening, never a detail cached from an earlier
 * opening of the card: an open form pins the first node it is given, and a
 * stale one would be refused.
 */
export function freshRead(query: {
  data?: PlanNodeDetailOutput | undefined;
  error: Error | null;
  isFetchedAfterMount: boolean;
  refetch: () => Promise<{ data?: PlanNodeDetailOutput | undefined }>;
}): PlanNodeRead {
  return {
    node: query.isFetchedAfterMount && query.error === null ? query.data?.node : undefined,
    error: query.error,
    refetch: async () => (await query.refetch()).data?.node,
  };
}

/**
 * What the rail needs of a step before its own read answers: a board card, or
 * a lane row of the overview, which reads no tree — its children, counts and
 * goal come from the rail's read instead.
 */
export type PlanRailNode = Pick<
  PlanTreeNode,
  | 'nodeId'
  | 'kind'
  | 'title'
  | 'status'
  | 'revision'
  | 'noteHead'
  | 'closedAt'
  | 'pullRequest'
  | 'goalHead'
  | 'rounds'
  | 'children'
> &
  Partial<Pick<PlanTreeNode, 'activity'>> & { counts: Pick<PlanTreeNode['counts'], 'runs'> };

export interface PlanRailProps {
  node: PlanRailNode;
  column: PlanBoardColumn;
  /** Why the step needs the operator, where it stands under Needs you. */
  reason: PlanNeedsYouReason | undefined;
  /** The step the stream walk takes next for its plan. */
  next: boolean;
  phase: Pick<PlanTreeNode, 'title'> | undefined;
  spaceId: string;
  spaceSlug: string;
  onClose: PlanNodeCloser;
  /** For a stranded step: the closed step above it, which the rail offers to reopen. */
  closedAncestor?: Pick<PlanTreeNode, 'nodeId' | 'title'> | undefined;
  onOpen: PlanNodeOpener;
  /** **Revise** on a blocked step: the operator's note back, the step left blocked. */
  onRevise: PlanNodeReviser;
  /** The close form open, if any; a card's Decide opens the rail with it open. */
  choosing: 'done' | 'dropped' | null;
  onChoose: (choosing: 'done' | 'dropped' | null) => void;
  onDismiss: () => void;
}

export function PlanRail({
  node,
  column,
  reason,
  next,
  phase,
  spaceId,
  spaceSlug,
  onClose,
  closedAncestor,
  onOpen,
  onRevise,
  choosing,
  onChoose,
  onDismiss,
}: PlanRailProps) {
  const [allRuns, setAllRuns] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
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
  // The operator's conversations that wrote the step, which link themselves on
  // it. A `session` link carries other sessions too, so the read filters by the
  // engine's label before it cuts the page.
  const conversations = useApiQuery<PlanNodeDetailOutput>({
    key: ['space', spaceId, 'plan', 'node', node.nodeId, 'links', 'conversation'],
    path: planNodePath(
      spaceId,
      node.nodeId,
      `linkKind=session&linkLabel=${PLAN_NODE_CONVERSATION_LINK_LABEL}&limit=${String(PLAN_RAIL_CONVERSATIONS)}`,
    ),
  });
  const conversationLinks = conversations.data?.links ?? [];
  // The plan document behind the step (Plan 337 D2): links come newest first,
  // so a page of one is the newest.
  const documents = useApiQuery<PlanNodeDetailOutput>({
    key: ['space', spaceId, 'plan', 'node', node.nodeId, 'links', 'document'],
    path: planNodePath(spaceId, node.nodeId, 'linkKind=document&limit=1'),
  });
  const documentLink = documents.data?.links[0];
  // The closed step above a stranded one, read fresh as the rail's own node
  // is: its revision is what a Reopen of it is pinned to.
  const ancestorDetail = useApiQuery<PlanNodeDetailOutput>({
    key: ['space', spaceId, 'plan', 'node', closedAncestor?.nodeId ?? '', 'head'],
    path: planNodePath(spaceId, closedAncestor?.nodeId ?? '', 'limit=1'),
    staleTime: 0,
    enabled: closedAncestor !== undefined,
  });
  const full = detail.data?.node;
  const card = full?.card;
  const criteriaLabel = full?.kind === 'decide' ? 'Decided when' : 'Done when';
  // The step's own read says whether a run is on it; until it answers, a card
  // says. A lane row carries no activity, so it reads idle until the read
  // answers: a waiting step whose run has ended never shows running first.
  const runInFlight = (detail.data?.activity ?? node.activity ?? 'idle') === 'in_flight';
  const columnLabel = PLAN_BOARD_COLUMNS.find((c) => c.id === column)?.label ?? column;
  const runLinks = detail.data?.links ?? [];
  const inFlight = (detail.data?.runs ?? []).filter((run) => run.nodeId === node.nodeId);
  const runsTotal = detail.data?.linksTotal ?? node.counts.runs;
  const open = !isClosedStatus(full?.status ?? node.status);
  const railRead = freshRead(detail);
  // A lane row carries no children; the rail's own read lists them.
  const openUnder = [...node.children, ...(detail.data?.children ?? [])].some(
    (child) => !isClosedStatus(child.status),
  );

  return (
    <Column gap="lg" className="ds-enter-rise" data-plan-rail={node.nodeId} style={{ minWidth: 0 }}>
      <Row gap="xs" align="center" justify="between">
        <Row gap="xs" align="center" wrap>
          <PlanStepOrb column={column} runInFlight={runInFlight} size={PLAN_ORB_SIZE.rail} />
          <Badge variant={COLUMN_BADGE[column]}>{columnLabel}</Badge>
          {reason !== undefined && (
            <Badge variant="warning">{NEEDS_YOU_REASON_LABEL[reason]}</Badge>
          )}
          {next && <NextMarker />}
        </Row>
        <RailDismiss onDismiss={onDismiss} />
      </Row>
      <Column gap="xs">
        {phase !== undefined && (
          <Text size="xs" variant="muted" data-plan-rail-phase>
            {phaseLabel(phase.title)}
          </Text>
        )}
        <Heading level={4}>{node.title}</Heading>
      </Column>
      <Row gap="xs" align="center" wrap>
        {node.pullRequest !== undefined && (
          <a href={node.pullRequest.url} target="_blank" rel="noopener noreferrer">
            <PullRequestChip pullRequest={node.pullRequest} />
          </a>
        )}
        {node.pullRequest?.mergeSha !== undefined && (
          <Text variant="mono" size="xs">
            {node.pullRequest.mergeSha.slice(0, 7)}
          </Text>
        )}
        {node.rounds > 0 && (
          <Text size="xs" variant="muted">
            {reviewRoundsLabel(node.rounds)}
          </Text>
        )}
        {(full?.closedAt ?? node.closedAt) !== undefined && (
          <Text size="xs" variant="muted">
            {`Closed ${shortTime((full?.closedAt ?? node.closedAt)!)}`}
          </Text>
        )}
      </Row>
      {documentLink !== undefined && <ReadThePlan documentRef={documentLink.ref} />}
      {detail.error && (
        <Text size="sm" tone="danger" role="alert">
          {`This step could not be read: ${detail.error.message}`}
        </Text>
      )}
      {node.noteHead !== undefined && (
        <RailSection label="Now">
          <Text size="base" color="secondary" style={railProse}>
            {node.noteHead}
          </Text>
        </RailSection>
      )}
      {card !== undefined && full !== undefined ? (
        <>
          <PlanCardSections card={card} criteria={full.criteria} criteriaLabel={criteriaLabel} />
          {/* Under a card the goal is the brief, which the card already says for the operator. */}
          <RailSection label="Goal">
            <Row>
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={goalOpen}
                onClick={() => {
                  setGoalOpen((held) => !held);
                }}
              >
                {goalOpen ? 'Hide goal' : 'Show goal'}
              </Button>
            </Row>
            {goalOpen && <RailMarkdown content={full.goal} data-plan-goal />}
          </RailSection>
        </>
      ) : (
        <>
          <RailSection label="Goal">
            {/* Until the read answers, the goal's head stands in, plain as on the card. */}
            {full !== undefined ? (
              <RailMarkdown content={full.goal} data-plan-goal />
            ) : (
              <Text size="base" color="secondary" style={railProse}>
                {node.goalHead}
              </Text>
            )}
          </RailSection>
          {full !== undefined && (
            <RailSection label={criteriaLabel}>
              <RailMarkdown content={full.criteria} data-plan-criteria />
            </RailSection>
          )}
        </>
      )}
      {full?.note !== undefined && (
        <RailSection label="Working note">
          <Row>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={noteOpen}
              onClick={() => {
                setNoteOpen((held) => !held);
              }}
            >
              {noteOpen ? 'Hide note' : 'Show note'}
            </Button>
          </Row>
          {noteOpen && <RailMarkdown content={full.note} data-plan-note />}
        </RailSection>
      )}
      {full?.outcome !== undefined && (
        <RailSection label="Outcome">
          <div
            data-plan-outcome
            style={{
              border: '1px solid var(--color-border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-2)',
            }}
          >
            <RailMarkdown content={full.outcome} />
          </div>
        </RailSection>
      )}
      {(inFlight.length > 0 || runLinks.length > 0) && (
        <RailSection label="Runs">
          <ul style={listStyle}>
            {inFlight.map((run) => (
              <li key={run.runId}>
                <PlanRunLine run={run} spaceSlug={spaceSlug} />
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
        </RailSection>
      )}
      {(findings.data?.links.length ?? 0) > 0 && (
        <RailSection label="Carried forward">
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
        </RailSection>
      )}
      <RailSection label="Discuss">
        <Row gap="xs" align="center" wrap>
          <Link
            href={spaceRoute(
              spaceSlug,
              `/chat?draft=${encodeURIComponent(planDiscussDraft({ nodeId: node.nodeId, title: node.title }))}`,
            )}
            style={linkStyle}
            data-plan-discuss={node.nodeId}
          >
            Discuss with the Helmsman
          </Link>
        </Row>
        {conversationLinks.length > 0 && (
          <ul style={listStyle} data-plan-conversations>
            {conversationLinks.map((link) => (
              <li key={link.ref}>
                <Row gap="xs" align="center">
                  <Link
                    href={spaceRoute(spaceSlug, `/chat?session=${encodeURIComponent(link.ref)}`)}
                    style={linkStyle}
                  >
                    Conversation
                  </Link>
                  <Text size="xs" variant="muted">
                    {shortTime(link.createdAt)}
                  </Text>
                </Row>
              </li>
            ))}
          </ul>
        )}
      </RailSection>
      {/* The operator's own writes, apart from what the step says, as the designer keeps its save apart. */}
      <Column
        gap="sm"
        style={{ borderTop: '1px solid var(--color-border-subtle)', paddingTop: 'var(--space-md)' }}
      >
        {reason === 'blocked' && (
          <PlanNodeOpenControl
            nodeId={node.nodeId}
            verb="approve"
            label="Approve"
            read={railRead}
            onOpen={onOpen}
            onRevise={onRevise}
          />
        )}
        {reason === 'stranded' && closedAncestor !== undefined && (
          <PlanNodeOpenControl
            nodeId={closedAncestor.nodeId}
            verb="reopen"
            label={`Reopen ${phaseLabel(closedAncestor.title)}`}
            read={freshRead(ancestorDetail)}
            onOpen={onOpen}
          />
        )}
        {open ? (
          <PlanNodeCloseControl
            node={node}
            openUnder={openUnder}
            read={railRead}
            onClose={onClose}
            choosing={choosing}
            onChoose={onChoose}
          />
        ) : (
          <PlanNodeOpenControl
            nodeId={node.nodeId}
            verb="reopen"
            label="Reopen"
            read={railRead}
            onOpen={onOpen}
          />
        )}
      </Column>
    </Column>
  );
}

/**
 * The rail for a step the URL names that the view on screen does not hold —
 * a closed step, or one a link points at — over the overview (Plan 332 D8):
 * the step's own read places it, and the rail renders once that read answers.
 * It is the read the rail itself makes, under the same key, so it is made once.
 */
export function PlanRailFromDetail({
  nodeId,
  ...controls
}: Omit<PlanRailProps, 'node' | 'column' | 'reason' | 'next' | 'phase' | 'closedAncestor'> & {
  nodeId: string;
}) {
  const detail = useApiQuery<PlanNodeDetailOutput>({
    key: ['space', controls.spaceId, 'plan', 'node', nodeId],
    path: planNodePath(controls.spaceId, nodeId, `linkKind=run&limit=${String(PLAN_RAIL_RUNS)}`),
    staleTime: 0,
  });
  if (detail.data === undefined) {
    return (
      <Column gap="xs" data-plan-rail-reading={nodeId}>
        <Row justify="end">
          <RailDismiss onDismiss={controls.onDismiss} />
        </Row>
        {detail.error ? (
          <Text size="sm" tone="danger" role="alert">
            {`This step could not be read: ${detail.error.message}`}
          </Text>
        ) : (
          <Text size="sm" variant="muted">
            Reading the step…
          </Text>
        )}
      </Column>
    );
  }
  const { node, placement, closedAncestor } = planDetailRailNode(detail.data);
  return (
    <PlanRail
      node={node}
      column={placement.column}
      reason={placement.reason}
      next={false}
      phase={undefined}
      closedAncestor={closedAncestor}
      {...controls}
    />
  );
}
