import {
  toolResultObservationOf,
  type OperationObservation,
  type ToolResultObservation,
} from '@aflow/schemas';
import { buildToolResultSummaryWithMeta } from './outputSummary.js';

/**
 * The observation stamp for a finished step's tool result, from its
 * operation's declaration. Each receipt is summarised exactly as the full
 * result is, so a reduced result reads like the full one with the stale
 * facets taken out. An output that holds no facet and neither moves nor ends
 * a thing is not stamped and is always shown in full.
 */
export function toolResultObservation(
  declaration: OperationObservation,
  output: unknown,
  toolCallId: string,
  operationId: string,
): ToolResultObservation | undefined {
  return toolResultObservationOf(
    declaration,
    output,
    (shown) => buildToolResultSummaryWithMeta(shown, toolCallId, operationId).text,
  );
}
