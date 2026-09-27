export type TimeoutSource =
  | { kind: 'explicit'; requestedSeconds: number }
  | { kind: 'preset'; presetName: string; presetSeconds: number }
  | { kind: 'default'; defaultSeconds: number };

/**
 * The teaching tail of a timeout-kill error: names where the enforced limit
 * came from and the exact knob (with its space-policy ceiling) that raises it,
 * so the agent can retry correctly instead of blind. Ephemeral workspace runs
 * additionally learn that pre-kill /workspace/ writes are already durable, so
 * a retry can resume from checkpoints instead of restarting (sessioned runs
 * flush at teardown, not at the kill, so they keep the base message).
 */
export function buildTimeoutTeaching(args: {
  policyMaxTimeoutSeconds: number;
  source: TimeoutSource;
  workspaceEnabled: boolean;
}): string {
  const { policyMaxTimeoutSeconds: policyMax, source } = args;
  const requested =
    source.kind === 'explicit'
      ? source.requestedSeconds
      : source.kind === 'preset'
        ? source.presetSeconds
        : source.defaultSeconds;
  const origin =
    source.kind === 'explicit'
      ? 'limits.timeoutSeconds'
      : source.kind === 'preset'
        ? `runtimePreset '${source.presetName}'`
        : 'the default';
  const workspaceClause = args.workspaceEnabled
    ? '; writes to /workspace/ before the kill were flushed to Memory (see workspaceFlush) — ' +
      'checkpoint incremental state there and resume from it instead of restarting'
    : '';
  if (requested >= policyMax) {
    return (
      `limit is this space's maxExecutionSeconds ceiling of ${String(policyMax)}s ` +
      `(requested ${String(requested)}s via ${origin}) — ask the space admin to raise it to go higher` +
      workspaceClause
    );
  }
  return (
    `limit set by ${origin} (${String(requested)}s); this space allows up to ${String(policyMax)}s ` +
    `— pass limits: { timeoutSeconds: <n> } (max ${String(policyMax)}) to raise it` +
    workspaceClause
  );
}
