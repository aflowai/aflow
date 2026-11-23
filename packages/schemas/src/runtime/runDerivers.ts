// ============================================================================
// Run derivers
// ============================================================================

export type RunDeriverResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

/**
 * A pure function named by `workflow.run.derive`. It computes a value from
 * the arguments a task binds from earlier outputs, so a number that follows
 * from those outputs by rule is never asked of a model. The same arguments
 * always give the same value. It reads nothing else and changes nothing.
 */
export type RunDeriverFn = (args: Record<string, unknown>) => RunDeriverResult;

const _derivers = new Map<string, RunDeriverFn>();

export function registerRunDeriver(name: string, fn: RunDeriverFn): void {
  const existing = _derivers.get(name);
  if (existing && existing !== fn) {
    throw new Error(`runDerivers: "${name}" is already registered with a different function.`);
  }
  _derivers.set(name, fn);
}

export function getRunDeriver(name: string): RunDeriverFn | null {
  return _derivers.get(name) ?? null;
}

export function listRunDeriverNames(): string[] {
  return [..._derivers.keys()].sort();
}
