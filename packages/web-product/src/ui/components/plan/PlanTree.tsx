'use client';

/**
 * A space's plan as the operator reads it (Plan 322 P3): each tree, every node
 * under its parent in position order, a closed node with how it ended, and
 * what was done for each — its links and the runs in flight serving it.
 *
 * Given `onClose`, an open node also offers the operator's own writes (P3.2):
 * mark it done with how its criteria were met — for a `decide` node, the
 * choice — or drop it, and the branch under it with it. The form reads the
 * node as it now stands and shows its goal and criteria, so the operator
 * decides against what the node says; the page writes through the plan engine
 * against the revision the form showed, and a node changed since is refused
 * rather than overwritten.
 */
import { useState } from 'react';
import Link from 'next/link';
import {
  Badge,
  Button,
  Column,
  Row,
  Text,
  Textarea,
  type BadgeVariant,
} from '@aflow/design-system';
import type {
  PlanNode,
  PlanNodeGetOutput,
  PlanNodeKind,
  PlanNodeLink,
  PlanNodeRun,
  PlanNodeStatus,
  PlanTreeNode,
} from '@aflow/schemas';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { spaceRoute } from '../../lib/space-routes.js';
import { PLAN_LINK_KIND_LABEL, planLinkTarget, planLinkText } from '../../lib/plan-links.js';

const STATUS_BADGE: Record<PlanNodeStatus, BadgeVariant> = {
  active: 'info',
  waiting: 'paused',
  blocked: 'warning',
  done: 'success',
  dropped: 'neutral',
};

/** What each status asks of the operator, said where the badge alone is terse. */
const STATUS_TITLE: Record<PlanNodeStatus, string> = {
  active: 'Being worked on',
  waiting: 'Waiting on a run',
  blocked: 'Waiting on a person',
  done: 'Done against its criteria',
  dropped: 'Let go',
};

const KIND_LABEL: Record<PlanNodeKind, string> = {
  execute: 'build',
  investigate: 'investigate',
  decide: 'decide',
};

const linkStyle = { color: 'var(--color-text-link)' } as const;

function PlanLinkItem({ link, spaceSlug }: { link: PlanNodeLink; spaceSlug: string }) {
  const target = planLinkTarget(link, spaceSlug);
  const text = planLinkText(link);
  const detail = link.label !== undefined && link.label !== text ? link.label : undefined;
  return (
    <li>
      <Row gap="xs" align="center" wrap>
        <Text size="xs" variant="muted">
          {PLAN_LINK_KIND_LABEL[link.kind]}
        </Text>
        {target.kind === 'internal' ? (
          <Link href={target.href} style={linkStyle}>
            {text}
          </Link>
        ) : target.kind === 'external' ? (
          <a href={target.href} target="_blank" rel="noopener noreferrer" style={linkStyle}>
            {text}
          </a>
        ) : (
          <Text size="sm">{text}</Text>
        )}
        {detail !== undefined && (
          <Text size="xs" variant="muted">
            {detail}
          </Text>
        )}
      </Row>
    </li>
  );
}

function PlanRunItem({ run, spaceSlug }: { run: PlanNodeRun; spaceSlug: string }) {
  return (
    <li>
      <Row gap="xs" align="center" wrap>
        <Badge variant={run.status}>{run.status}</Badge>
        <Link
          href={spaceRoute(spaceSlug, `/runs/${encodeURIComponent(run.runId)}`)}
          style={linkStyle}
        >
          {run.slug}
        </Link>
        <Text size="xs" variant="muted">
          {`started ${new Date(run.startedAt).toLocaleString()}`}
        </Text>
      </Row>
    </li>
  );
}

/** What the operator asks of one node: close it, against the revision they read. */
export interface PlanNodeCloseRequest {
  nodeId: string;
  expectedRevision: number;
  status: 'done' | 'dropped';
  outcome?: string;
}

export type PlanNodeCloseAnswer = { ok: true } | { ok: false; message: string };

export type PlanNodeCloser = (request: PlanNodeCloseRequest) => Promise<PlanNodeCloseAnswer>;

function isClosed(status: PlanNodeStatus): boolean {
  return status === 'done' || status === 'dropped';
}

const CLOSING_COPY: Record<
  'done' | 'decide' | 'dropped',
  { open: string; field: string; confirm: string }
> = {
  done: { open: 'Mark done', field: 'How its criteria were met', confirm: 'Mark done' },
  decide: {
    open: 'Decide',
    field: 'Your decision — recorded as its outcome',
    confirm: 'Record decision',
  },
  dropped: { open: 'Drop', field: 'Why it is dropped (optional)', confirm: 'Drop' },
};

/** What the node says, as the form read it: what the operator closes it against. */
function PlanNodeStatement({ shown, read }: { shown: PlanNode; read: PlanTreeNode }) {
  return (
    <Column gap="xs" data-plan-statement={shown.nodeId}>
      {shown.revision !== read.revision && (
        <Text size="xs" variant="muted">
          This step changed since the plan was read; this is how it stands now.
        </Text>
      )}
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
        <Text as="span" size="sm" weight="medium">
          {'Goal: '}
        </Text>
        {shown.goal}
      </Text>
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
        <Text as="span" size="sm" weight="medium">
          {shown.kind === 'decide' ? 'Decided when: ' : 'Done when: '}
        </Text>
        {shown.criteria}
      </Text>
    </Column>
  );
}

function PlanNodeCloseControl({
  node,
  spaceId,
  onClose,
}: {
  node: PlanTreeNode;
  spaceId: string;
  onClose: PlanNodeCloser;
}) {
  const [choosing, setChoosing] = useState<'done' | 'dropped' | null>(null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read when the form opens, never from the tree's summary: the goal and
  // criteria are what the operator decides against, and the revision the
  // write is pinned to is the one they were read at.
  const read = useApiQuery<PlanNodeGetOutput>({
    key: ['space', spaceId, 'plan', 'node', node.nodeId],
    path: `/spaces/${spaceId}/plan/nodes/${node.nodeId}`,
    enabled: choosing !== null,
    staleTime: 0,
  });
  const shown = choosing !== null ? read.data?.node : undefined;
  const shownClosed = shown !== undefined && isClosed(shown.status);
  const openUnder = node.children.some((child) => !isClosed(child.status));

  const copyFor = (status: 'done' | 'dropped') =>
    CLOSING_COPY[status === 'done' && node.kind === 'decide' ? 'decide' : status];

  if (choosing === null) {
    return (
      <Row gap="xs" align="center">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setChoosing('done');
          }}
        >
          {copyFor('done').open}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setChoosing('dropped');
          }}
        >
          {openUnder ? 'Drop branch' : copyFor('dropped').open}
        </Button>
      </Row>
    );
  }

  const copy = copyFor(choosing);
  const outcome = text.trim();
  const submit = async () => {
    if (!shown) return;
    setPending(true);
    setError(null);
    const answer = await onClose({
      nodeId: node.nodeId,
      expectedRevision: shown.revision,
      status: choosing,
      ...(outcome.length > 0 ? { outcome } : {}),
    });
    setPending(false);
    if (answer.ok) {
      setChoosing(null);
      setText('');
    } else {
      setError(answer.message);
      // Show the node as it now stands, so a retry is decided against that.
      void read.refetch();
    }
  };

  return (
    <Column gap="xs" data-plan-close={choosing}>
      {shown !== undefined ? (
        <PlanNodeStatement shown={shown} read={node} />
      ) : read.error ? (
        <Text size="sm" tone="danger" role="alert">
          {`This step could not be read: ${read.error.message}`}
        </Text>
      ) : (
        <Text size="sm" variant="muted">
          Reading the step…
        </Text>
      )}
      {shownClosed && (
        <Text size="sm" tone="danger" role="alert">
          {`This step is ${shown.status} now; reload the plan to see it.`}
        </Text>
      )}
      <Textarea
        aria-label={copy.field}
        placeholder={copy.field}
        value={text}
        rows={3}
        disabled={pending}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      {choosing === 'dropped' && openUnder && (
        <Text size="xs" variant="muted">
          The open steps under it leave the plan with it.
        </Text>
      )}
      {error !== null && (
        <Text size="sm" tone="danger" role="alert">
          {error}
        </Text>
      )}
      <Row gap="xs" align="center">
        <Button
          size="sm"
          variant={choosing === 'dropped' ? 'danger' : 'primary'}
          loading={pending}
          disabled={
            pending ||
            shown === undefined ||
            shownClosed ||
            (choosing === 'done' && outcome.length === 0)
          }
          onClick={() => {
            void submit();
          }}
        >
          {choosing === 'dropped' && openUnder ? 'Drop branch' : copy.confirm}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setChoosing(null);
            setText('');
            setError(null);
          }}
        >
          Cancel
        </Button>
      </Row>
    </Column>
  );
}

function PlanNodeItem({
  node,
  spaceSlug,
  spaceId,
  onClose,
  underClosed,
}: {
  node: PlanTreeNode;
  spaceSlug: string;
  spaceId: string;
  onClose: PlanNodeCloser | undefined;
  /** Some node above it is closed: it left the plan with that branch. */
  underClosed: boolean;
}) {
  const closed = isClosed(node.status);
  const moreLinks = node.linksTotal - node.links.length;
  return (
    <li data-plan-node={node.nodeId} data-status={node.status}>
      <Column gap="xs" style={{ paddingBlock: 'var(--space-2)' }}>
        <Row gap="sm" align="center" wrap>
          <Badge variant={STATUS_BADGE[node.status]} title={STATUS_TITLE[node.status]}>
            {node.status}
          </Badge>
          <Text weight="medium" color={closed ? 'secondary' : 'primary'}>
            {node.title}
          </Text>
          <Text size="xs" variant="muted">
            {KIND_LABEL[node.kind]}
          </Text>
        </Row>
        {node.outcome !== undefined && (
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            <Text as="span" size="sm" weight="medium">
              {node.status === 'dropped' ? 'Why dropped: ' : 'Outcome: '}
            </Text>
            {node.outcome}
          </Text>
        )}
        {!closed && node.noteHead !== undefined && (
          <Text size="sm" variant="muted">
            {node.noteHead}
          </Text>
        )}
        {node.runs.length > 0 && (
          <ul aria-label="Runs in flight" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {node.runs.map((run) => (
              <PlanRunItem key={run.runId} run={run} spaceSlug={spaceSlug} />
            ))}
          </ul>
        )}
        {node.links.length > 0 && (
          <ul aria-label="Links" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {node.links.map((link) => (
              <PlanLinkItem key={`${link.kind}:${link.ref}`} link={link} spaceSlug={spaceSlug} />
            ))}
          </ul>
        )}
        {moreLinks > 0 && (
          <Text size="xs" variant="muted">
            {`${String(moreLinks)} older link${moreLinks === 1 ? '' : 's'} not shown`}
          </Text>
        )}
        {!closed && !underClosed && node.kind === 'decide' && (
          <Text size="sm" variant="muted">
            Waiting on your decision — here or in the Action Center.
          </Text>
        )}
        {!closed && onClose !== undefined && (
          <PlanNodeCloseControl node={node} spaceId={spaceId} onClose={onClose} />
        )}
      </Column>
      {node.children.length > 0 && (
        <PlanNodeList
          nodes={node.children}
          spaceSlug={spaceSlug}
          spaceId={spaceId}
          onClose={onClose}
          underClosed={underClosed || closed}
          nested
        />
      )}
    </li>
  );
}

function PlanNodeList({
  nodes,
  spaceSlug,
  spaceId,
  onClose,
  underClosed,
  nested = false,
}: {
  nodes: readonly PlanTreeNode[];
  spaceSlug: string;
  spaceId: string;
  onClose: PlanNodeCloser | undefined;
  underClosed: boolean;
  nested?: boolean;
}) {
  return (
    <ul
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        ...(nested
          ? {
              paddingLeft: 'var(--space-4)',
              borderLeft: '1px solid var(--color-border-subtle)',
            }
          : {}),
      }}
    >
      {nodes.map((node) => (
        <PlanNodeItem
          key={node.nodeId}
          node={node}
          spaceSlug={spaceSlug}
          spaceId={spaceId}
          onClose={onClose}
          underClosed={underClosed}
        />
      ))}
    </ul>
  );
}

export interface PlanTreeProps {
  /** The trees as `GET /v1/spaces/:spaceId/plan` nests them, roots in position order. */
  roots: readonly PlanTreeNode[];
  /** The space's slug, which internal links are built under. */
  spaceSlug: string;
  /** The space's id, which the close form reads its node under. */
  spaceId: string;
  /** Writes the operator's close of a node; without it the tree is read-only. */
  onClose?: PlanNodeCloser;
}

export function PlanTree({ roots, spaceSlug, spaceId, onClose }: PlanTreeProps) {
  return (
    <PlanNodeList
      nodes={roots}
      spaceSlug={spaceSlug}
      spaceId={spaceId}
      onClose={onClose}
      underClosed={false}
    />
  );
}
