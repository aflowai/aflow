'use client';

/**
 * A space's plan as the operator reads it (Plan 322 P3): each tree, every node
 * under its parent in position order, a closed node with how it ended, and
 * what was done for each — its links and the runs in flight serving it.
 *
 * Read-only on purpose. The plan is written by the Helmsman's `plan.node.*`
 * operations; an operator's own writes are the next slice and arrive through
 * the same engine, not through this component.
 */
import Link from 'next/link';
import { Badge, Column, Row, Text, type BadgeVariant } from '@aflow/design-system';
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

function PlanNodeItem({ node, spaceSlug }: { node: PlanTreeNode; spaceSlug: string }) {
  const closed = node.status === 'done' || node.status === 'dropped';
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
      </Column>
      {node.children.length > 0 && (
        <PlanNodeList nodes={node.children} spaceSlug={spaceSlug} nested />
      )}
    </li>
  );
}

function PlanNodeList({
  nodes,
  spaceSlug,
  nested = false,
}: {
  nodes: readonly PlanTreeNode[];
  spaceSlug: string;
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
        <PlanNodeItem key={node.nodeId} node={node} spaceSlug={spaceSlug} />
      ))}
    </ul>
  );
}

export interface PlanTreeProps {
  /** The trees as `GET /v1/spaces/:spaceId/plan` nests them, roots in position order. */
  roots: readonly PlanTreeNode[];
  /** The space's slug, which internal links are built under. */
  spaceSlug: string;
}

export function PlanTree({ roots, spaceSlug }: PlanTreeProps) {
  return <PlanNodeList nodes={roots} spaceSlug={spaceSlug} />;
}
