/**
 * Which operations the edition running this process actually composes.
 *
 * An operation whose lane is absent is not a capability the deployment has and
 * is withheld rather than refused late: discovery that lists it spends a turn
 * teaching an agent a tool that can only fail at dispatch, and on the local
 * edition the catalog advertised the whole `code` step type against an
 * executor the appliance does not ship.
 *
 * Lane composition is a separate axis from every other gate. The space's
 * capability profile, the run grant and the space policy all answer what an
 * operator permits of a capability that exists; this answers whether it exists.
 */
import type { EditionDescriptor } from './descriptor.js';

/** The descriptor fields lane composition rests on. */
export type ComposedLanes = Pick<
  EditionDescriptor,
  'edition' | 'codeLane' | 'hostLane' | 'browserLane'
>;

/** Whether the deployment composes an executor for `stepType` at all. */
export function isStepTypeComposed(stepType: string, lanes: ComposedLanes): boolean {
  if (stepType === 'code') return lanes.codeLane === 'present';
  if (stepType === 'host') return lanes.hostLane === 'present';
  if (stepType === 'browser') return lanes.browserLane === 'present';
  return true;
}

/**
 * Whether the deployment composes a lane able to serve `operationId`.
 *
 * Reads the step type off the id rather than the registry so an unregistered
 * spelling answers the same way the registry lookup would reject it, and so
 * the check holds in surfaces that carry an id and no operation record.
 */
export function isOperationComposed(operationId: string, lanes: ComposedLanes): boolean {
  const stepType = operationId.split('.')[0];
  return stepType === undefined || isStepTypeComposed(stepType, lanes);
}

/**
 * A lane whose name alone would not tell the agent what is missing. A browser
 * here is not a service the deployment runs but one on a paired machine.
 */
const LANE_PHRASES: Readonly<Record<string, string>> = {
  browser: 'the browser lane, a browser on a paired machine',
};

/**
 * Why a deployment cannot serve this operation, in the agent's own terms.
 *
 * Names the edition, because the remedy differs by it: a hosted instance has no
 * machine to pair with, and a local one reaches code through its host lane.
 */
export function uncomposedOperationReason(
  operationId: string,
  lanes: ComposedLanes,
): string | null {
  if (isOperationComposed(operationId, lanes)) return null;
  const stepType = operationId.split('.')[0] ?? operationId;
  return (
    `lane_not_composed: "${operationId}" needs ${LANE_PHRASES[stepType] ?? `the ${stepType} lane`}, which the ` +
    `${lanes.edition} edition running here does not compose. No promotion or call can reach it.`
  );
}
