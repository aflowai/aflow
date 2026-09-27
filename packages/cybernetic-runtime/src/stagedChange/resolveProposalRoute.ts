import type { StagedChangeOp, StagedChangeResolutionRoute } from '@aflow/schemas';
import { isPlatformWorkflowSlug } from '@aflow/platform-artifacts';

export interface ResolveProposalRouteInput {
  /** The workflow slug the proposal targets (if any). */
  targetSlug?: string | undefined;
  /** Typed change ops carried by the proposal. */
  ops: readonly StagedChangeOp[];
}

export function resolveProposalRoute(
  input: ResolveProposalRouteInput,
): StagedChangeResolutionRoute {
  if (input.ops.some((op) => op.op === 'platform_issue')) {
    return 'platform_issue';
  }
  if (input.targetSlug && isPlatformWorkflowSlug(input.targetSlug)) {
    return 'platform_issue';
  }
  return 'tenant_ratification';
}

/**
 * Memory directory for tenant-ratifiable proposals. Coach proposals + any
 * other StagedChange writers default here when `resolveProposalRoute` returns
 * `tenant_ratification`.
 */
export const PROPOSAL_TENANT_DIR = '/coach/staged' as const;

/**
 * Memory directory for platform-issue reports. Diagnostic proposals targeting
 * platform-owned artifacts land here so they're easy to enumerate without
 * filtering by `targetWorkflowSlug`.
 */
export const PROPOSAL_PLATFORM_DIR = '/coach/platform-issues' as const;

/** All directories that may contain `StagedChange` records. */
export const PROPOSAL_DIRS = [PROPOSAL_TENANT_DIR, PROPOSAL_PLATFORM_DIR] as const;

/** Resolve the storage directory for a given resolution route. */
export function proposalDirForRoute(route: StagedChangeResolutionRoute): string {
  return route === 'platform_issue' ? PROPOSAL_PLATFORM_DIR : PROPOSAL_TENANT_DIR;
}

/** Resolve the storage path for a proposal id and route. */
export function proposalPath(route: StagedChangeResolutionRoute, proposalId: string): string {
  return `${proposalDirForRoute(route)}/${proposalId}.json`;
}
