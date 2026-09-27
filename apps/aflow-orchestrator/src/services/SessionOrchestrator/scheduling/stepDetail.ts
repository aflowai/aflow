import { summarizeStepInput } from '@aflow/schemas';

/**
 * Summarize a step's input for the run surface.
 *
 * Reads only the inline form on purpose. This runs for every step scheduled and
 * the value is a display label, so resolving a stored payload here would put a
 * network round trip on the scheduling path to decorate the steps whose input
 * was large. A spilled input yields no label instead.
 */
export function extractStepDetail(operationId: string, inputRef: string): string | undefined {
  try {
    if (!inputRef.startsWith('inline:')) return undefined;
    const json = Buffer.from(inputRef.slice(7), 'base64').toString('utf-8');
    const input = JSON.parse(json) as Record<string, unknown>;
    return summarizeStepInput(operationId, input);
  } catch {
    return undefined;
  }
}
