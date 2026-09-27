/**
 * The Helmsman's tool surface, composed for the edition the process runs as.
 *
 * The registry definition carries the hosted surface; this is the one place the
 * local edition's differs, so an operating-model decision is a list here rather
 * than a branch scattered across the turn assembler, the prompt and discovery.
 *
 * Helmsman steers and executes only to check, and that rule is carried by each
 * operation's usage hints rather than by taking the operation away: the write,
 * patch and shell operations stay promotable, each naming its boundary and the
 * hand-off past it. An operator who wants a Helmsman that never writes removes
 * them through the space's `capabilityDiscovery.helmsmanOperations` ceiling,
 * which already replaces the promotable set per space. What this file decides
 * is only what the role reaches for without a promotion round.
 */
import { isOperationComposed, type ComposedLanes } from '@aflow/schemas';

export interface HelmsmanSurface {
  /** The every-turn set. */
  coreOperations: string[];
  /** The discovery ceiling — findable and promotable at runtime. */
  promotableOperations: string[];
}

/**
 * The machine reads and the harness, pinned on the local edition.
 *
 * Assessment is steering work and happens on most turns, and the harness is how
 * a task is commissioned once the assessment is done. Promoting either one by
 * hand is a round trip on every task that touches the operator's machine.
 */
const LOCAL_PINNED_OPERATIONS: readonly string[] = [
  'host.harness.run',
  'host.file.list',
  'host.file.get',
];

/**
 * What leaves the every-turn set to pay for them, so the pinned set keeps its
 * size. Each stays promotable: the campaign reads are drill-ins the context
 * already summarizes, and one of the two inline renders covers the turn.
 */
const LOCAL_UNPINNED_OPERATIONS: readonly string[] = [
  'workflow.campaign.list',
  'workflow.campaign.get',
  'ui.surface.visualize',
];

/**
 * Compose the Helmsman's two tiers from the authored defaults and the edition.
 *
 * Both tiers first lose every operation whose lane the edition does not
 * compose, so the every-turn awareness names nothing that search and promotion
 * would hide. Past that, pure and order-preserving: a hosted edition composing
 * every lane the registry names gets back exactly what it was given, which is
 * what makes "the hosted surface is unchanged" a byte-for-byte assertion.
 */
export function composeHelmsmanSurface(
  authored: {
    readonly coreOperations: readonly string[];
    readonly promotableOperations: readonly string[];
  },
  lanes: ComposedLanes,
): HelmsmanSurface {
  const core = authored.coreOperations.filter((op) => isOperationComposed(op, lanes));
  const promotable = authored.promotableOperations.filter((op) => isOperationComposed(op, lanes));

  if (lanes.edition !== 'community-local' || lanes.hostLane !== 'present') {
    return { coreOperations: core, promotableOperations: promotable };
  }

  const unpinned = new Set(LOCAL_UNPINNED_OPERATIONS);
  const pinned = new Set(LOCAL_PINNED_OPERATIONS);

  const coreOperations = core.filter((op) => !unpinned.has(op));
  for (const op of LOCAL_PINNED_OPERATIONS) {
    if (!coreOperations.includes(op)) coreOperations.push(op);
  }

  const promotableOperations = promotable.filter((op) => !pinned.has(op));
  for (const op of LOCAL_UNPINNED_OPERATIONS) {
    if (!promotableOperations.includes(op)) promotableOperations.push(op);
  }

  return { coreOperations, promotableOperations };
}
