'use client';

/**
 * A space's plan as the operator reads it (Plan 322 P3): each tree, every node
 * under its parent in position order, a closed node with how it ended, and
 * what was done for each — its links and the runs in flight serving it.
 *
 * Given `onClose`, an open node also offers the operator's own writes (P3.2):
 * mark it done with how its criteria were met — for a `decide` node, the
 * choice — or drop it, and the branch under it with it. The component only
 * asks; the page writes through the plan engine, against the revision this
 * tree was read at, and a node changed since is refused rather than overwritten.
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
  PlanNodeKind,
  PlanNodeLink,
  PlanNodeRun,
  PlanNodeStatus,
  PlanTreeNode,
} from '@aflow/schemas';
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

function PlanNodeCloseControl({ node, onClose }: { node: PlanTreeNode; onClose: PlanNodeCloser }) {
  const [choosing, setChoosing] = useState<'done' | 'dropped' | null>(null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setPending(true);
    setError(null);
    const answer = await onClose({
      nodeId: node.nodeId,
      expectedRevision: node.revision,
      status: choosing,
      ...(outcome.length > 0 ? { outcome } : {}),
    });
    setPending(false);
    if (answer.ok) {
      setChoosing(null);
      setText('');
    } else {
      setError(answer.message);
    }
  };

  return (
    <Column gap="xs" data-plan-close={choosing}>
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
          disabled={pending || (choosing === 'done' && outcome.length === 0)}
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
  onClose,
  underClosed,
}: {
  node: PlanTreeNode;
  spaceSlug: string;
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
        {!closed && onClose !== undefined && <PlanNodeCloseControl node={node} onClose={onClose} />}
      </Column>
      {node.children.length > 0 && (
        <PlanNodeList
          nodes={node.children}
          spaceSlug={spaceSlug}
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
  onClose,
  underClosed,
  nested = false,
}: {
  nodes: readonly PlanTreeNode[];
  spaceSlug: string;
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
  /** Writes the operator's close of a node; without it the tree is read-only. */
  onClose?: PlanNodeCloser;
}

export function PlanTree({ roots, spaceSlug, onClose }: PlanTreeProps) {
  return <PlanNodeList nodes={roots} spaceSlug={spaceSlug} onClose={onClose} underClosed={false} />;
}
