import { processEditionDescriptor, type CatalogConfig, type SpaceContext } from '@aflow/schemas';
import type { HelmsmanCapabilities } from '@aflow/cybernetic-runtime';

/**
 * What the space can reach, for the prompt assembler.
 *
 * Reachability is `coreOperations` UNION the discovery allowlist, never the live
 * pinned set: a promotable op is reachable, and the doctrine teaching the agent
 * to promote it must ship or the path is never found. The live set also changes
 * mid-run as tools are promoted, which would rewrite the prompt mid-session.
 */
export function resolveHelmsmanCapabilities(
  spaceContext: SpaceContext | undefined,
  catalogConfig: CatalogConfig | undefined,
): HelmsmanCapabilities {
  const edition = processEditionDescriptor();
  const reachable = new Set<string>([
    ...(catalogConfig?.coreOperations ?? []),
    ...(catalogConfig?.discovery?.allowedOperationIds ?? []),
  ]);
  return {
    canRenderInline: reachable.has('ui.surface.visualize') || reachable.has('ui.artifact.render'),
    // `total` counts `needs_credentials` and `disabled` alongside `bound`, so a
    // space whose only integrations are unusable would still be taught how to
    // call them. Only a bound one makes the doctrine actionable. Presence, not
    // count — one callable service is enough to need the flow.
    hasIntegrations: (spaceContext?.integrations?.items ?? []).some((i) => i.status === 'bound'),
    canLinkToRoutes: spaceContext?.navigation !== undefined,
    // The edition, not the space: a harness is commissionable where the local
    // edition composes a host lane, whatever a given space has bound.
    canCommissionHarness: edition.edition === 'community-local' && edition.hostLane === 'present',
    // The space's discovery ceiling can drop any of these while the harness
    // stays reachable, and the operating model must not name a step the
    // surface then refuses.
    canApplyDiff: reachable.has('host.file.patch'),
    canWriteFiles: reachable.has('host.file.put'),
    canRunCommands: reachable.has('host.process.exec'),
  };
}
