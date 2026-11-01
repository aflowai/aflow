'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Badge, Card, CardBody, Column, Row, Text, type BadgeVariant } from '@aflow/design-system';
import {
  ACTION_CENTER_FOCUS_ITEM_ID_PREFIXES,
  ACTION_CENTER_ITEM_ID_PREFIX,
  PLAN_STATE_LABELS,
  actionCenterFocusCard,
} from '@aflow/schemas';
import type { InlineProposalFocusPayload } from '@aflow/run-view';
import { useApi, useSpace } from '../providers.js';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import * as actionCenterBroker from '../../hooks/action-center-broker.js';
import type { ActionCenterItem } from '../../hooks/use-action-center-types.js';
import { spaceRoute } from '../../lib/space-routes.js';

type ActionCenterItemStatus = ActionCenterItem['status'];

export interface InlineFocusedItemProps {
  itemId: string;
  reason?: string;
  listed?: InlineProposalFocusPayload['listed'];
}

type FocusPrefix = (typeof ACTION_CENTER_FOCUS_ITEM_ID_PREFIXES)[number];

/**
 * What each item an agent can focus, other than a proposal, is called by its
 * id's prefix. Keyed by the prefixes the focus input takes, so a prefix added
 * there does not compile here until it has a label.
 */
const KIND_LABEL: Record<Exclude<FocusPrefix, 'proposal'>, string> = {
  'plan-ask': 'Plan step',
  'plan-decision': 'Plan decision',
  'workflow-task': 'Run task',
  'workflow-write-approval': 'Write approval',
  'workflow-oauth-consent': 'Connection',
  step: 'Paused step',
  gate: 'Gate',
  settings: 'Settings request',
};

/** The prefixes whose ids name a plan node, as the plan sources write them. */
const PLAN_NODE_PREFIXES = [
  ACTION_CENTER_ITEM_ID_PREFIX.planAsk,
  ACTION_CENTER_ITEM_ID_PREFIX.planDecision,
] as const;

const STATE: Record<ActionCenterItemStatus, { label: string; variant: BadgeVariant }> = {
  open: { label: PLAN_STATE_LABELS.workbenchSection, variant: 'warning' },
  resolving: { label: 'Resolving', variant: 'running' },
  resolved: { label: 'Resolved', variant: 'success' },
  expired: { label: 'Expired', variant: 'neutral' },
  cancelled: { label: 'Cancelled', variant: 'cancelled' },
};

/** The state of an item its source no longer lists: it was answered, or it went away. */
const GONE = {
  label: `No longer ${PLAN_STATE_LABELS.workbenchSection.toLowerCase()}`,
  variant: 'neutral',
} as const;

function kindLabel(itemId: string): string {
  const prefix = ACTION_CENTER_FOCUS_ITEM_ID_PREFIXES.find(
    (p): p is keyof typeof KIND_LABEL => p !== 'proposal' && itemId.startsWith(`${p}:`),
  );
  return prefix !== undefined ? KIND_LABEL[prefix] : 'Request';
}

/** The plan node a plan step's id names, where its card links to the plan page. */
function planNodeOf(itemId: string): string | null {
  if (actionCenterFocusCard(itemId) !== 'plan_page') return null;
  for (const prefix of PLAN_NODE_PREFIXES) {
    if (itemId.startsWith(prefix)) {
      const nodeId = itemId.slice(prefix.length);
      return nodeId.length > 0 ? nodeId : null;
    }
  }
  return null;
}

/**
 * An Action Center item an agent pointed at, other than a proposal: its kind,
 * its title, its state and where it is acted on. The live item is read the
 * way the proposal card reads it, and read again whenever the Action Center
 * stream says it moved. Where the live item cannot be read, the title the
 * agent's attention block listed stands in, so the card always names what
 * the agent pointed at.
 */
export function InlineFocusedItem({ itemId, reason, listed }: InlineFocusedItemProps) {
  const { apiUrl, headers, authFetch, blockedSession } = useApi();
  const sessionExpired = blockedSession !== null;
  const { activeSpaceId, activeSpace } = useSpace();

  const query = useApiQuery<ActionCenterItem>({
    key: ['space', activeSpaceId ?? '', 'action-center', 'item', itemId],
    path: `/spaces/${activeSpaceId ?? ''}/action-center/${encodeURIComponent(itemId)}`,
    enabled: Boolean(activeSpaceId),
  });
  const { refetch } = query;

  useEffect(() => {
    if (!activeSpaceId) return;
    actionCenterBroker.acquire(activeSpaceId, {
      apiUrl,
      headers,
      authFetch,
      isSessionExpired: () => sessionExpired,
    });
    const unsubUpdate = actionCenterBroker.subscribeItemsUpdate(activeSpaceId, (updates) => {
      if (updates.some((it) => it.id === itemId)) void refetch();
    });
    const unsubResolve = actionCenterBroker.subscribeResolve(activeSpaceId, (ids) => {
      if (ids.includes(itemId)) void refetch();
    });
    return () => {
      unsubUpdate();
      unsubResolve();
      actionCenterBroker.release(activeSpaceId);
    };
  }, [activeSpaceId, itemId, apiUrl, headers, authFetch, sessionExpired, refetch]);

  const item = query.data;
  const gone = query.error?.status === 404;
  const state = item ? STATE[item.status] : gone ? GONE : null;
  const title = item?.title ?? listed?.title ?? itemId;
  const planNode = planNodeOf(itemId);

  return (
    <Card>
      <CardBody>
        <Column gap="xs">
          <Row gap="sm" align="center">
            <Text size="xs" color="muted">
              {kindLabel(itemId)}
            </Text>
            {state ? (
              <Badge variant={state.variant}>{state.label}</Badge>
            ) : (
              <Text size="xs" color="muted">
                {query.isError ? 'State unavailable' : 'Loading state…'}
              </Text>
            )}
          </Row>
          <Text size="sm" weight="medium">
            {title}
          </Text>
          {reason ? (
            <Text size="xs" color="muted" style={{ fontStyle: 'italic' }}>
              {reason}
            </Text>
          ) : null}
          {planNode !== null ? (
            <Text size="xs">
              <Link
                href={spaceRoute(activeSpace?.slug, `/plan?node=${encodeURIComponent(planNode)}`)}
              >
                Open it on the plan
              </Link>
            </Text>
          ) : (
            <Text size="xs" color="muted">
              Act on it under {PLAN_STATE_LABELS.workbenchSection} in the Workbench.
            </Text>
          )}
        </Column>
      </CardBody>
    </Card>
  );
}
