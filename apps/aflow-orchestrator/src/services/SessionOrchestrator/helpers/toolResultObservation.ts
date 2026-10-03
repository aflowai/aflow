import {
  observationKeyOf,
  withoutObservedFields,
  type OperationObservation,
  type ToolResultObservation,
} from '@aflow/schemas';
import { buildToolResultSummaryWithMeta } from './outputSummary.js';

/**
 * The observation stamp for a finished step's tool result, from its
 * operation's declaration. The receipt is summarised exactly as the full
 * result is, from the output without its observed fields, so the reduced
 * result reads like the full one with the bulk taken out. An output with no
 * key at the declared path is not stamped and is always shown in full.
 */
export function toolResultObservation(
  declaration: OperationObservation,
  output: unknown,
  toolCallId: string,
  operationId: string,
): ToolResultObservation | undefined {
  const key = observationKeyOf(output, declaration.keyPath);
  if (key === undefined) return undefined;
  if (declaration.role === 'ends') return { role: 'ends', group: declaration.group, key };
  const receipt = buildToolResultSummaryWithMeta(
    withoutObservedFields(output, declaration.observedFields),
    toolCallId,
    operationId,
  ).text;
  return {
    role: 'observes',
    group: declaration.group,
    key,
    receipt,
    currentStateOperation: declaration.currentStateOperation,
  };
}
