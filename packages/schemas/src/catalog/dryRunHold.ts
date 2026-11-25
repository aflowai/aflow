import { getOperation } from './registry.js';

/**
 * What a dry run does with one operation a task asks for:
 *
 * - `run`: it runs for real. Reads, model calls and the run's own machinery.
 * - `endpoint`: an API call. The API executor decides after the request is
 *   resolved. A read that saves nothing runs, and every write tier and every
 *   call that saves its response to memory is held.
 * - `hold`: the orchestrator holds it before dispatch. Nothing executes it.
 */
export type DryRunWriteDisposition = 'run' | 'endpoint' | 'hold';

const API_CALL_OPERATIONS = new Set(['api.http.call']);

/**
 * Operations held whatever the registry says of them. `api.http.download`
 * always saves its response as a memory document. `agent.control.resume`
 * re-parents and resumes any paused session of the tenant by id, and that
 * session keeps its own hot state with no `dryRunOf`, so its writes after the
 * resume would go live.
 */
const DRY_RUN_HELD_OPERATIONS = new Set(['api.http.download', 'agent.control.resume']);

/**
 * Write-mode operations that are the run's own machinery rather than a write
 * to the space or the world. A model turn, a task's control calls, a question
 * to a person and a session's own tool surface change nothing a dry run must
 * leave as it found it. A child run started from a dry run is a dry run too.
 *
 * Each entry names one operation, never a prefix, so an operation added under
 * a machinery group is held until it is named here. The `ai.*` operations
 * other than the turn fall through to the registry: the model calls are reads
 * and run, and the media operations store their output as memory documents
 * and are held.
 */
const DRY_RUN_MACHINERY_OPERATIONS = new Set([
  'ai.agent.turn',
  'agent.control.dispatch',
  'agent.control.delegate',
  'agent.control.abort',
  'agent.control.end',
  'agent.control.run_step',
  'agent.control.draft_patch',
  'agent.control.draft_get',
  'agent.control.submit_output',
  'agent.control.signal_blocked',
  'human.chat.ask',
  'user.interaction.ask',
  'user.interaction.approve',
  'catalog.tool.promote',
  'mcp.tool.promote',
  'ui.surface.visualize',
  'workflow.run.start',
]);

/**
 * The disposition of `operationId` in a dry run. An operation the registry
 * does not know is held, so the hold fails closed.
 */
export function dryRunWriteDisposition(operationId: string): DryRunWriteDisposition {
  if (API_CALL_OPERATIONS.has(operationId)) return 'endpoint';
  if (DRY_RUN_HELD_OPERATIONS.has(operationId)) return 'hold';
  if (DRY_RUN_MACHINERY_OPERATIONS.has(operationId)) return 'run';
  const descriptor = getOperation(operationId);
  if (descriptor === undefined) return 'hold';
  if (descriptor.accessMode === 'read' && !descriptor.mutates) return 'run';
  return 'hold';
}
