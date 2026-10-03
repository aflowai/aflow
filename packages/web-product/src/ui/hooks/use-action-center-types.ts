/**
 * Shared types for the Action Center surface — used by both
 * `use-action-center.ts` (the consumer hook) and
 * `action-center-broker.ts` (the SSE transport). Lives in its own
 * module so the broker can import without creating a circular dep
 * with the hook.
 *
 * Mirrors the server's `ActionCenterItem` shape without pulling in
 * `@aflow/schemas` (keeps the web bundle light).
 */

/**
 * Runtime mirror of the server's `ActionCenterItemKindSchema` enum. The web
 * keeps a hand-written mirror to avoid pulling `@aflow/schemas` into the
 * client bundle; the `actionCenterTypeLockstep.test.ts` guard fails if this
 * drifts from the server enum.
 */
export const ACTION_CENTER_AUDIENCES = ['anyone', 'you', 'someone_else'] as const;
export type ActionCenterAudience = (typeof ACTION_CENTER_AUDIENCES)[number];

export const ACTION_CENTER_ITEM_KINDS = [
  'human_input',
  'human_approval',
  'ratification',
  'platform_issue',
  'coach_activity',
  'trigger_armed',
  'needs_oauth_consent',
  'write_approval',
  'session_invitation',
  'browser_handoff',
] as const;

export type ActionCenterItemKind = (typeof ACTION_CENTER_ITEM_KINDS)[number];

export const ACTION_CENTER_ALLOWED_ACTIONS = [
  'submit',
  'approve',
  'reject',
  'ratify',
  'dismiss',
  'comment',
  'reassign',
  'connect',
] as const;

export type ActionCenterAllowedAction = (typeof ACTION_CENTER_ALLOWED_ACTIONS)[number];

export type ActionCenterItemOrigin =
  | {
      type: 'step';
      runId: string;
      stepExecutionId: string;
      sessionId: string;
      pauseVersion: number;
      operationId: string;
    }
  | {
      type: 'gate';
      runId: string;
      stepExecutionId: string;
      sessionId: string;
      pauseVersion: number;
      gateRequestId: string;
    }
  | {
      type: 'proposal';
      proposalId: string;
      proposalRevision: number;
      resolutionRoute: 'tenant_ratification' | 'platform_issue';
    }
  | {
      type: 'settings';
      recordKind: string;
      recordId: string;
      recordVersion: number;
    }
  | {
      type: 'workflow_task';
      runId: string;
      taskId: string;
      pauseVersion: number;
    }
  | {
      type: 'coach_activity';
      activityId: string;
      outcome: string;
      createdAt: string;
    }
  | {
      type: 'trigger_armed';
      scheduleId: string;
      createdAt: string;
    }
  | {
      type: 'browser_handoff';
      spaceId: string;
      hostname: string;
      profileId: string;
      site: string;
      reason: 'sign_in' | 'challenge' | 'confirm';
      message: string;
      startedAt: string;
      waiting: Array<{ runId: string; stepExecutionId: string; sessionId?: string }>;
    };

export interface CoachProposalExtension {
  kind: 'coach_proposal';
  /** Underlying StagedChange kind (e.g. `'workflow_refinement'`, `'skill_compose'`). */
  proposalKind: string;
  /**
   * Raw `StagedChange.proposal.summary`. Carried separately from
   * the AC item's top-level `summary` (which is inbox-flavoured for
   * non-Coach surfaces) so `<ProposalCard>` can render the Coach's
   * authored line as the card title regardless of which panel
   * mounts it.
   */
  proposalSummary: string;
  rationale: string;
  confidence: string;
  opCount: number;
  opKinds: string[];
  authorityLevel: 'auto_apply' | 'stage_for_review' | 'require_operator';
  targetWorkflowSlug: string | null;
  hasReflectionEvidence: boolean;
  lastRatificationError?: {
    reason:
      | 'unknown'
      | 'transient'
      | 'target_skill_missing'
      | 'workflow_not_found'
      | 'post_validation'
      | 'platform_artifact_read_only'
      | 'precondition_missing';
    op: string;
    detail: string;
    at: string;
  };
  rebaseState?: 'clean' | 'stale';
  staleSummary?: {
    conflictCount: number;
    firstOpKind: string | null;
  };
  validationsSummary?: {
    overallSafe: boolean;
    warningCount: number;
    blockerCount?: number;
  };
  applyPreviewStatus?: {
    result: 'ok';
    previewedAt: string;
    workflowRevisionAtPreview: number | null;
  };
}

export interface OAuthConsentExtension {
  kind: 'oauth_consent';
  integrationKind: 'mcp' | 'api';
  resourceKey: string;
  bindingId: string;
  ownerScope: 'user' | 'space';
  reason: 'never_connected' | 'expired';
  consentUrlHint?: string;
  authorizationUrlHint?: string;
}

export interface WriteApprovalExtension {
  kind: 'write_approval';
  apiId: string;
  endpointId: string;
  endpointName?: string;
  operationLabel?: string;
  method: string;
  urlHost: string;
  writeRiskTier: 'read' | 'low' | 'medium' | 'high';
  bodyPreview?: string;
  initiatedBy?: string;
}

export type ActionCenterItemExtension =
  CoachProposalExtension | OAuthConsentExtension | WriteApprovalExtension;

export interface ActionCenterItem {
  id: string;
  spaceId: string;
  kind: ActionCenterItemKind;
  origin: ActionCenterItemOrigin;
  title: string;
  summary: string;
  bodyRef?: string;
  uiHints?: {
    mode?: 'text' | 'textarea' | 'form' | 'chat' | 'choices' | 'diff';
    submitLabel?: string;
    approveLabel?: string;
    rejectLabel?: string;
  };
  resolutionSchema?: Record<string, unknown>;
  extension?: ActionCenterItemExtension;
  requestedAt: string;
  expiresAt?: string;
  requestedBy: {
    kind: 'agent' | 'gate' | 'coach' | 'workflow' | 'system';
    label: string;
    sessionId?: string;
    userId?: string;
  };
  priority: 'normal' | 'high';
  gateContext?: {
    operationId: string;
    reason: string;
    sources: ReadonlyArray<'op' | 'binding' | 'profile'>;
    bindingId?: string;
    capabilityGroupId?: string;
    riskModifiers?: string[];
    callInputRef: string;
    gateRequestId: string;
  };
  relatesTo: ReadonlyArray<{
    kind: 'step' | 'proposal' | 'binding' | 'workflow' | 'memory_doc';
    id: string;
    label?: string;
  }>;
  allowedActions: readonly ActionCenterAllowedAction[];
  /** Who may answer this, when it was addressed to particular people or a role. */
  resolverPolicy?: {
    minResolvers: number;
    requireAll: boolean;
    candidateResolvers?: readonly string[];
  };
  /** Who it is waiting on, from the reading person's point of view. */
  audience: ActionCenterAudience;
  /** Who it is currently being asked of, when someone routed it. Attention, never authority. */
  assignee?: string;
  status: 'open' | 'resolving' | 'resolved' | 'expired' | 'cancelled';
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionError?: {
    reason: string;
    severity: 'transient' | 'stale_target' | 'permanent';
    detail?: string;
    attempts: number;
  };
}

export interface ActionCenterFocusEvent {
  itemId: string;
  spaceId: string;
  /** Echoed from the publisher; useful for sanity assertion in the consumer. */
  tenantId: string;
  /** Optional rationale shown to the operator (<=280 chars at the publisher). */
  reason?: string;
  /** Publish timestamp (ms since epoch). Useful for debounce/dedupe in consumers. */
  ts: number;
}
