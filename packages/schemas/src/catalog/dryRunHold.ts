import { getOperation } from './registry.js';

/**
 * What a dry run does with one operation a task asks for:
 *
 * - `run`: it runs for real. Reads, model calls and the run's own machinery.
 * - `endpoint`: an API call. The API executor decides from the endpoint's
 *   write-risk tier, after the request is resolved, so a read runs and every
 *   write tier is held.
 * - `hold`: the orchestrator holds it before dispatch. Nothing executes it.
 */
export type DryRunWriteDisposition = 'run' | 'endpoint' | 'hold';

const API_CALL_OPERATIONS = new Set(['api.http.call', 'api.http.download']);

/**
 * Write-mode operations that are the run's own machinery rather than a write
 * to the space or the world. A model turn, a task's control calls, a question
 * to a person and a session's own tool surface change nothing a dry run must
 * leave as it found it. A child run started from a dry run is a dry run too.
 */
const DRY_RUN_MACHINERY_OPERATIONS = new Set([
  'human.chat.ask',
  'user.interaction.ask',
  'user.interaction.approve',
  'catalog.tool.promote',
  'mcp.tool.promote',
  'ui.surface.visualize',
  'workflow.run.start',
]);

const DRY_RUN_MACHINERY_PREFIXES = ['ai.', 'agent.control.'];

/**
 * The disposition of `operationId` in a dry run. An operation the registry
 * does not know is held, so the hold fails closed.
 */
export function dryRunWriteDisposition(operationId: string): DryRunWriteDisposition {
  if (API_CALL_OPERATIONS.has(operationId)) return 'endpoint';
  if (DRY_RUN_MACHINERY_OPERATIONS.has(operationId)) return 'run';
  if (DRY_RUN_MACHINERY_PREFIXES.some((prefix) => operationId.startsWith(prefix))) return 'run';
  const descriptor = getOperation(operationId);
  if (descriptor === undefined) return 'hold';
  if (descriptor.accessMode === 'read' && !descriptor.mutates) return 'run';
  return 'hold';
}
