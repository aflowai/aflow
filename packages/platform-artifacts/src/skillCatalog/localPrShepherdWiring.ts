/**
 * What every module of the Local PR Shepherd (Plan 321) wires its tasks with:
 * a task's output, a run input, a bound name, and the reads and lease takers
 * that more than one of them binds through.
 */

export function ctx(operation: string) {
  return {
    strategy: 'scoped' as const,
    contextPolicy: 'auto-optimize' as const,
    learnings: 'none' as const,
    capabilities: { operations: [operation], integrations: [] },
  };
}

export function out(taskId: string, path?: string) {
  return { kind: 'task_output' as const, taskId, ...(path !== undefined ? { path } : {}) };
}

export function runInput(path: string) {
  return { kind: 'run_input' as const, path };
}

export function bind(name: string) {
  return { $bind: name };
}

/** A value as text, absent where it is absent or null — so a `$concat` part falls through to its default. */
export function text(name: string) {
  return { $text: [bind(name)] };
}

/** A text part, or nothing where any of its parts is absent. */
export function optionalPart(...parts: unknown[]) {
  return { $firstOf: [{ $concat: parts }, ''] };
}

export const SKIP = 'skip' as const;

// --- Reads every task after the folder shares -------------------------------

export const REPOSITORY = {
  owner: out('read-folder', 'origin.owner'),
  repo: out('read-folder', 'origin.repo'),
};

export const NUMBER = { number: out('read-pr', 'data.number') };
export const HEAD_REF = { headRef: out('read-pr', 'data.headRef') };
export const BASE_REF = { baseRef: out('read-pr', 'data.baseRef') };

/** The loop's own pull request, as GitHub returned it: what every read after it reads under. */
export const OURS = {
  allOf: ['tasks.read-pr.output.statusCode == 200', 'tasks.read-pr.output.data.ours == true'],
  onMissingRef: SKIP,
};

export const DECIDED_FIX = {
  expression: "tasks.decide.output.decision == 'fix'",
  onMissingRef: SKIP,
};

export const DECIDED_MERGE = {
  expression: "tasks.decide.output.decision == 'merge'",
  onMissingRef: SKIP,
};

/**
 * The pass acts — `fix` or `merge` — as comparisons a guard's `allOf` can
 * hold beside others: no decision but those two and these three exists.
 */
export const DECIDED_TO_ACT = ['wait', 'abandon', 'leave'].map(
  (decision) => `tasks.decide.output.decision != '${decision}'`,
);

/** The loop's own pull request, from a folder whose merge posture is `when-green`: the merge reads run only there. */
export const OURS_WHEN_GREEN = {
  allOf: [...OURS.allOf, "tasks.read-folder.output.branchPolicy.mergePosture == 'when-green'"],
  onMissingRef: SKIP,
};

/**
 * The handoff, from whichever read found it: the comment a pass pinned, read
 * by its id, or — where none is pinned, or it is gone — the newest page of
 * the conversation. At most one of the two holds a record. The newest page
 * comes first: it is read only after the pinned comment answered 404, and
 * that answer must not stand in for the page's.
 */
export const HANDOFF_READS = ['read-pr-handoff', 'read-pr-handoff-pinned'] as const;

export function handoffBindings(name: string, path?: string) {
  return Object.fromEntries(
    HANDOFF_READS.map((taskId) => [`${name}_${taskId.replace(/-/g, '_')}`, out(taskId, path)]),
  );
}

export function handoffValue(name: string) {
  return {
    $firstOf: HANDOFF_READS.map((taskId) => bind(`${name}_${taskId.replace(/-/g, '_')}`)),
  };
}

/** The same, for a part of the handoff body: text, or absent. */
export function handoffText(name: string) {
  return {
    $firstOf: HANDOFF_READS.map((taskId) => ({
      $text: [bind(`${name}_${taskId.replace(/-/g, '_')}`)],
    })),
  };
}

/** The lease, from whichever task took it: created where none was, or taken over from a stale one. */
export const LEASE_TAKERS = ['lease', 'lease-takeover'] as const;

export function leaseBindings(name: string, path: string) {
  return Object.fromEntries(
    LEASE_TAKERS.map((taskId) => [`${name}_${taskId.replace(/-/g, '_')}`, out(taskId, path)]),
  );
}

export function leaseText(name: string) {
  return {
    $firstOf: LEASE_TAKERS.map((taskId) => ({
      $text: [bind(`${name}_${taskId.replace(/-/g, '_')}`)],
    })),
  };
}

export function leaseValue(name: string) {
  return { $firstOf: LEASE_TAKERS.map((taskId) => bind(`${name}_${taskId.replace(/-/g, '_')}`)) };
}

export function github(
  endpointId: string,
  params: Record<string, unknown>,
  transformPresetId?: unknown,
) {
  return {
    apiId: 'github',
    endpointId,
    params,
    response: {
      format: 'json',
      ...(transformPresetId !== undefined ? { transformPresetId } : {}),
    },
  };
}
