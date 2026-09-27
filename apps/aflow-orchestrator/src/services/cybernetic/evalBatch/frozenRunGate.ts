/**
 * Frozen-run write gate for operation tasks (Plan 269 D5). Operation tasks
 * are dispatched straight to executor job streams and never pass step
 * gating, so the trial's read-only grant cannot reach them — this gate is
 * the op-task half of the same posture. A `live` trial executes in the
 * production home space: any mutating operation task is refused at
 * dispatch, which fails the task (and so the run) with a typed reason —
 * a gradable observation, never a production write. `seeded` and `sealed`
 * trials run inside their own fixture space, which is the isolation boundary,
 * so their operation tasks dispatch normally — and a sealed trial's writes land
 * in a simulated world that reaches no service at all.
 */
import { getOperation } from '@aflow/schemas';

const EVAL_FIXTURE_TIERS = ['live', 'seeded', 'sealed'] as const;
export type LaunchableFixtureTier = (typeof EVAL_FIXTURE_TIERS)[number];

/** Narrow `workflow_runs.metadata.evalFixtureTier` (the launcher's stamp). */
export function extractEvalFixtureTier(runMetadata: unknown): LaunchableFixtureTier | undefined {
  if (runMetadata === null || runMetadata === undefined || typeof runMetadata !== 'object') {
    return undefined;
  }
  const raw = (runMetadata as Record<string, unknown>)['evalFixtureTier'];
  return (EVAL_FIXTURE_TIERS as readonly unknown[]).includes(raw)
    ? (raw as LaunchableFixtureTier)
    : undefined;
}

/**
 * Returns the refusal reason when this operation task must not dispatch,
 * or null when dispatch may proceed. A frozen run with no tier stamp is
 * treated as `live` — the strictest posture is the only safe default for
 * an anomalous frozen run.
 */
export function decideFrozenOpTaskDispatch(
  run: { evalBatchId: string | null; metadata: unknown },
  operationId: string,
): string | null {
  if (typeof run.evalBatchId !== 'string') return null;
  const tier = extractEvalFixtureTier(run.metadata) ?? 'live';
  if (tier !== 'live') return null;
  const mutates = getOperation(operationId)?.mutates ?? true;
  if (!mutates) return null;
  return (
    `EVAL_FROZEN_WRITE_DENIED: operation '${operationId}' mutates state, and this run is a ` +
    `live-tier eval trial holding the read-only eval grant in the production space. ` +
    `The failed write IS the trial's observation; re-tier the case to 'seeded' if the ` +
    `skill's writes are part of what the case measures.`
  );
}
