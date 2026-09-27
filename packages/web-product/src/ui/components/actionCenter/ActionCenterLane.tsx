'use client';

import { useState, type ReactElement } from 'react';
import { Badge, Card, CardBody, Column, HitlResolution, Row, Text } from '@aflow/design-system';
import type { PostInstallTask } from '@aflow/schemas';
import type { ActionCenterItem } from '../../hooks/use-action-center-types.js';
import type {
  ActionCenterResolution,
  UseActionCenterResult,
} from '../../hooks/use-action-center.js';
import { ProposalCard, type ProposalCardSummary } from '../cybernetic/ProposalCard.js';
import { OAuthConsentCard } from './OAuthConsentCard.js';
import { WriteApprovalCard } from './WriteApprovalCard.js';
import { SetupChecklist } from '../setup-checklist.js';
import { useSpaceFromRoute } from '../providers.js';
import { useNavigation } from '../navigation-provider.js';
import { AssignControl, AssigneeChip } from './AssignControl.js';
import { useSpacePeople } from '../../hooks/use-space-people.js';
import { useCurrentUser } from '../user-avatar.js';

export type ActionCenterNavigate = (target: {
  type: 'session' | 'workflow' | 'proposal';
  id: string;
}) => void;

export interface ActionCenterLaneProps {
  title: string;
  items: ActionCenterItem[];
  state: UseActionCenterResult;
  onNavigate?: ActionCenterNavigate;
  /** When true, render nothing if the lane is empty (Workbench). Default false
   *  keeps the standalone page's "nothing pending" placeholder card. */
  hideWhenEmpty?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
}

/**
 * One Action Center lane — a titled group of resolvable items — reused by the
 * standalone page and the Workbench (Plan 228 §6: one lane component, many
 * mounts). Each item renders through the same card set (HITL / proposal /
 * OAuth consent) regardless of where the lane is shown.
 */
export function ActionCenterLane({
  title,
  items,
  state,
  onNavigate,
  hideWhenEmpty = false,
  emptyTitle = 'Nothing pending',
  emptyDescription,
}: ActionCenterLaneProps): ReactElement | null {
  // Setup checklists returned by a store_install ratification. Held on the
  // lane because the resolved item card unmounts the moment the resolve
  // succeeds — the checklist is what remains for the operator to act on.
  const [setupChecklists, setSetupChecklists] = useState<
    Array<{ itemId: string; tasks: PostInstallTask[] }>
  >([]);
  const spaceSlug = useSpaceFromRoute()?.slug ?? '';
  const { push } = useNavigation();

  if (hideWhenEmpty && items.length === 0 && setupChecklists.length === 0) return null;

  return (
    <Column gap="sm">
      <Row gap="sm" align="center">
        <Text size="sm" weight="semibold">
          {title}
        </Text>
        {items.length > 0 && <Badge variant="warning">{String(items.length)}</Badge>}
      </Row>
      {items.length === 0 && setupChecklists.length === 0 ? (
        <Card>
          <CardBody>
            <Text size="sm" variant="muted">
              {emptyTitle}
              {emptyDescription ? ` · ${emptyDescription}` : ''}
            </Text>
          </CardBody>
        </Card>
      ) : (
        <Column gap="sm">
          {items.map((item) => (
            <ActionCenterItemCard
              key={item.id}
              item={item}
              state={state}
              {...(onNavigate ? { onNavigate } : {})}
              onSetupChecklist={(itemId, tasks) => {
                setSetupChecklists((prev) => [
                  ...prev.filter((entry) => entry.itemId !== itemId),
                  { itemId, tasks },
                ]);
              }}
            />
          ))}
          {setupChecklists.map(({ itemId, tasks }) => (
            <Column key={itemId} gap="sm">
              <Text size="sm" weight="medium">
                Setup checklist
              </Text>
              <SetupChecklist tasks={tasks} spaceSlug={spaceSlug} onNavigate={push} />
            </Column>
          ))}
        </Column>
      )}
    </Column>
  );
}

// ============================================================================
// Item card — wraps <HitlResolution> / <ProposalCard> / <OAuthConsentCard>
// ============================================================================

interface ActionCenterItemCardProps {
  item: ActionCenterItem;
  state: UseActionCenterResult;
  onNavigate?: ActionCenterNavigate;
  /** Called when a resolve returns post-install setup tasks (store_install ratification). */
  onSetupChecklist?: (itemId: string, tasks: PostInstallTask[]) => void;
}

export function ActionCenterItemCard(props: ActionCenterItemCardProps): ReactElement {
  // Every kind of request can be on someone's desk, so the routing row wraps
  // all of them rather than living inside the one card shape that used to
  // render it.
  return (
    <Column gap="xs">
      <RoutingRow item={props.item} state={props.state} />
      <ActionCenterItemBody {...props} />
    </Column>
  );
}

function ActionCenterItemBody({
  item,
  state,
  onNavigate,
  onSetupChecklist,
}: ActionCenterItemCardProps): ReactElement {
  const resolveState = state.resolveStateById[item.id] ?? 'idle';
  const resolveError = state.resolveErrorById[item.id];

  // Plan 185 §9.3 Plane A — a paused step waiting on OAuth consent renders a
  // "Connect {provider}" launch card. Resume is callback-driven, so this card
  // never goes through the resolve route.
  if (item.kind === 'needs_oauth_consent' && item.extension?.kind === 'oauth_consent') {
    return <OAuthConsentCard item={item} extension={item.extension} />;
  }

  // Plan 253 — a paused gated write renders a distinct approve/deny card with
  // the exact call (method · host · body preview) so the operator decides on
  // what will actually be sent.
  if (item.kind === 'write_approval' && item.extension?.kind === 'write_approval') {
    return (
      <WriteApprovalCard
        item={item}
        extension={item.extension}
        onResolve={async (resolution) => {
          await state.resolve(item.id, resolution);
        }}
        resolveState={resolveState}
        {...(resolveError ? { errorMessage: resolveError } : {})}
      />
    );
  }

  // Proposal-backed items render the unified <ProposalCard> so the full
  // proposal context (diff, evidence, validations) shows inline.
  if (
    item.origin.type === 'proposal' &&
    (item.kind === 'ratification' || item.kind === 'platform_issue')
  ) {
    const proposalId = item.origin.proposalId;
    const workflowRef = item.relatesTo.find((r) => r.kind === 'workflow');
    const ext = item.extension?.kind === 'coach_proposal' ? item.extension : null;
    const proposalSummary: ProposalCardSummary = {
      id: proposalId,
      kind: ext ? ext.proposalKind : item.kind,
      status: 'proposed',
      summary: ext ? ext.proposalSummary : item.summary,
      resolutionRoute: item.origin.resolutionRoute,
      targetWorkflowSlug: ext ? ext.targetWorkflowSlug : (workflowRef?.id ?? null),
      ...(ext
        ? {
            rationale: ext.rationale,
            confidence: ext.confidence,
            opKinds: ext.opKinds,
            hasReflectionEvidence: ext.hasReflectionEvidence,
            ...(ext.lastRatificationError
              ? { lastRatificationError: ext.lastRatificationError }
              : {}),
            ...(ext.rebaseState ? { rebaseState: ext.rebaseState } : {}),
            ...(ext.staleSummary ? { staleSummary: ext.staleSummary } : {}),
            ...(ext.validationsSummary ? { validationsSummary: ext.validationsSummary } : {}),
            ...(ext.applyPreviewStatus ? { applyPreviewStatus: ext.applyPreviewStatus } : {}),
          }
        : {}),
    };
    return (
      <ProposalCard
        proposal={proposalSummary}
        spaceId={item.spaceId}
        loadDetail={state.loadProposalDetail}
        actionError={resolveError ? { ok: false, error: resolveError } : null}
        onRatify={
          item.kind === 'ratification'
            ? async () => {
                const result = await state.resolve(item.id, { kind: 'ratify' });
                if (result.ok && result.setupChecklist && result.setupChecklist.length > 0) {
                  onSetupChecklist?.(item.id, result.setupChecklist);
                }
              }
            : undefined
        }
        onReject={
          item.kind === 'ratification'
            ? async (_id, reason) => {
                await state.resolve(
                  item.id,
                  reason ? { kind: 'reject', reason } : { kind: 'reject' },
                );
              }
            : undefined
        }
        onDismiss={
          item.kind === 'platform_issue'
            ? async (_id, reason) => {
                await state.resolve(
                  item.id,
                  reason ? { kind: 'dismiss', reason } : { kind: 'dismiss' },
                );
              }
            : undefined
        }
      />
    );
  }

  if (
    item.kind !== 'human_input' &&
    item.kind !== 'human_approval' &&
    item.kind !== 'ratification' &&
    item.kind !== 'platform_issue' &&
    item.kind !== 'session_invitation'
  ) {
    return <></>;
  }
  // An invitation is approval-shaped: approve joins, reject declines, and the
  // uiHints carry the words ('Join' / 'Decline').
  const hitlKind = item.kind === 'session_invitation' ? 'human_approval' : item.kind;
  // 'connect' launches out-of-band and 'reassign' is the routing control
  // above the form — neither is an answer, so neither reaches the form.
  const hitlAllowedActions = item.allowedActions.filter(
    (a): a is Exclude<typeof a, 'connect' | 'reassign'> => a !== 'connect' && a !== 'reassign',
  );

  const handleResolve = async (resolution: ActionCenterResolution): Promise<void> => {
    await state.resolve(item.id, resolution);
  };

  const backlinks = onNavigate ? buildBacklinks(item, onNavigate) : null;

  const sideEffectError = item.resolutionError
    ? `${item.resolutionError.reason}${item.resolutionError.detail ? `: ${item.resolutionError.detail}` : ''}`
    : undefined;

  const resolutionErrorMessage = resolveError ?? sideEffectError;

  return (
    <HitlResolution
      item={{
        id: item.id,
        kind: hitlKind,
        title: item.title,
        summary: item.summary,
        ...(item.resolutionSchema ? { resolutionSchema: item.resolutionSchema } : {}),
        ...(item.uiHints ? { uiHints: item.uiHints } : {}),
        allowedActions: hitlAllowedActions,
        ...(item.gateContext
          ? {
              gateContext: {
                operationId: item.gateContext.operationId,
                reason: item.gateContext.reason,
                ...(item.gateContext.bindingId ? { bindingId: item.gateContext.bindingId } : {}),
              },
            }
          : {}),
      }}
      onResolve={handleResolve}
      state={resolveState}
      {...(resolutionErrorMessage ? { errorMessage: resolutionErrorMessage } : {})}
      {...(backlinks ? { bodySlot: backlinks } : {})}
    />
  );
}

/** Whose desk this is on, and the control to move it. Hidden when neither applies. */
function RoutingRow({
  item,
  state,
}: {
  item: ActionCenterItem;
  state: UseActionCenterResult;
}): ReactElement | null {
  const personFor = useSpacePeople(item.spaceId);
  const currentUser = useCurrentUser();
  if (!item.assignee && !item.allowedActions.includes('reassign')) return null;
  return (
    <Row gap="sm" align="center" justify="end">
      <AssigneeChip
        assignee={item.assignee}
        currentUserId={currentUser?.userId}
        personFor={personFor}
      />
      <AssignControl item={item} state={state} spaceId={item.spaceId} />
    </Row>
  );
}

function buildBacklinks(item: ActionCenterItem, onNavigate: ActionCenterNavigate): ReactElement {
  const links: ReactElement[] = [];
  if (item.origin.type === 'step' || item.origin.type === 'gate') {
    const sessionId = item.origin.sessionId;
    links.push(
      <BacklinkButton
        key="session"
        label="Open session"
        onClick={() => {
          onNavigate({ type: 'session', id: sessionId });
        }}
      />,
    );
  }
  if (item.origin.type === 'proposal') {
    const proposalId = item.origin.proposalId;
    links.push(
      <BacklinkButton
        key="proposal"
        label="Open proposal"
        onClick={() => {
          onNavigate({ type: 'proposal', id: proposalId });
        }}
      />,
    );
  }
  const workflowRef = item.relatesTo.find((r) => r.kind === 'workflow');
  if (workflowRef) {
    links.push(
      <BacklinkButton
        key="workflow"
        label="Open workflow"
        onClick={() => {
          onNavigate({ type: 'workflow', id: workflowRef.id });
        }}
      />,
    );
  }
  return (
    <Row gap="sm" wrap>
      {links}
    </Row>
  );
}

function BacklinkButton({ label, onClick }: { label: string; onClick: () => void }): ReactElement {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'transparent',
        border: 'none',
        color: 'var(--color-accent-default, #6366f1)',
        padding: 0,
        font: 'inherit',
        cursor: 'pointer',
        textDecoration: 'underline',
      }}
    >
      {label}
    </button>
  );
}
