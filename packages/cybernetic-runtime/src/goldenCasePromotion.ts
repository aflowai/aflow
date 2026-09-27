/**
 * Run→draft-case promotion mining (Plan 269 D14). Pure over already-loaded
 * run facts: the platform persisted everything a case needs — validated start
 * inputs, campaign config, the pinned revision, the typed terminal state,
 * memory-read outputs — so promotion is mining, not authoring. The result is
 * always a DRAFT the operator edits (expectations mirror the OBSERVED
 * terminal state) and ratifies; gaps are recorded in `missing` and the
 * draft's notes instead of being papered over.
 */
import {
  getOperation,
  GoldenCaseContentSchema,
  CampaignConfigRecordSchema,
  WorkflowRunMetadataSchema,
  WorkflowRunPauseReasonSchema,
  type CaseExpectation,
  type CaseProvenance,
  type FixtureMemoryDoc,
  type GoldenCaseContent,
  type TaskTargetedInstructions,
} from '@aflow/schemas';

// ============================================================================
// Input facts (structural, so tests and handlers build them alike)
// ============================================================================

export interface PromotableRunFacts {
  runId: string;
  workflowSlug: string;
  status: string;
  pausedReason?: string | null | undefined;
  workflowRevision: number;
  campaignId?: string | null | undefined;
  metadata?: unknown;
  /** PayloadRef encoding the run's typed failure context, when one exists. */
  failureRef?: string | undefined;
}

export interface PromotableTaskFacts {
  taskId: string;
  status: string;
  operationId?: string | null | undefined;
  outputRef?: string | null | undefined;
  completedAtMs?: number | undefined;
  failureReason?: string | null | undefined;
}

const TERMINAL_STATUSES = new Set(['completed', 'paused', 'failed']);

// ============================================================================
// Memory-read mining helpers (the handler fetches payloads between these)
// ============================================================================

const RECOVERABLE_MEMORY_READ_OP = 'memory.store.get';

/**
 * Succeeded plain-get memory reads whose outputs carry a recoverable doc
 * body. Only these are ATTEMPTED as fixture-doc recovery — a failed attempt
 * here is a real gap. Other memory reads go through
 * {@link extractOtherMemoryReads} and are noted distinctly, never as
 * "could not be recovered".
 */
export function extractMemoryReadCandidates(
  tasks: readonly PromotableTaskFacts[],
): Array<{ taskId: string; outputRef: string }> {
  return tasks.flatMap((task) =>
    task.status === 'succeeded' &&
    task.operationId === RECOVERABLE_MEMORY_READ_OP &&
    typeof task.outputRef === 'string' &&
    task.outputRef.length > 0
      ? [{ taskId: task.taskId, outputRef: task.outputRef }]
      : [],
  );
}

/**
 * Succeeded memory-plane READS beyond the plain get (search/query/list/
 * vector_search/run_output …). Their result sets are not reproducible as
 * fixture docs, so promotion records them as a distinct note for the
 * operator, not a recovery gap. Read-vs-write is derived from the registry's
 * `mutates` flag, never a hand-kept verb list.
 */
export function extractOtherMemoryReads(
  tasks: readonly PromotableTaskFacts[],
): Array<{ taskId: string; operationId: string }> {
  return tasks.flatMap((task) => {
    if (
      task.status !== 'succeeded' ||
      typeof task.operationId !== 'string' ||
      !task.operationId.startsWith('memory.') ||
      task.operationId === RECOVERABLE_MEMORY_READ_OP
    ) {
      return [];
    }
    if (getOperation(task.operationId)?.mutates === true) return [];
    return [{ taskId: task.taskId, operationId: task.operationId }];
  });
}

/**
 * The task whose output becomes `provenance.referenceOutputRef` (or the
 * counterexample fallback): the last completed task carrying an output. The
 * handler durably re-stores exactly this ref before mining, so the selection
 * must be shared, not duplicated.
 */
export function selectReferenceOutputTask(
  tasks: readonly PromotableTaskFacts[],
): PromotableTaskFacts | undefined {
  return [...tasks]
    .filter((t) => typeof t.outputRef === 'string' && t.outputRef.length > 0)
    .sort((a, b) => (a.completedAtMs ?? 0) - (b.completedAtMs ?? 0))
    .at(-1);
}

/** Recognize a `memory.store.get`-shaped output as a mineable doc body. */
export function memoryDocFromOutput(output: unknown): { path: string; content: string } | null {
  if (output === null || typeof output !== 'object') return null;
  const record = output as Record<string, unknown>;
  const stat = record['stat'];
  if (stat === null || typeof stat !== 'object') return null;
  const path = (stat as Record<string, unknown>)['path'];
  if (typeof path !== 'string' || path.length === 0) return null;
  const data = record['data'];
  if (typeof data === 'string') return { path, content: data };
  if (record['dataJson'] !== undefined) {
    try {
      return { path, content: JSON.stringify(record['dataJson']) };
    } catch {
      return null;
    }
  }
  return null;
}

// ============================================================================
// The miner
// ============================================================================

export interface PromotionRejection {
  ok: false;
  code: 'run_not_terminal' | 'run_cancelled';
  detail: string;
}

export interface PromotionDraftResult {
  ok: true;
  content: GoldenCaseContent;
  mined: string[];
  missing: string[];
}

export function buildDraftCaseFromRun(params: {
  run: PromotableRunFacts;
  tasks: readonly PromotableTaskFacts[];
  /** The run's campaign config, when `run.campaignId` resolved to one. */
  campaignConfig?: Record<string, unknown> | undefined;
  /** Memory docs already fetched + re-encoded by the caller. */
  memoryDocs?: readonly FixtureMemoryDoc[] | undefined;
  /** Plain-get memory reads whose outputs could not be recovered into docs. */
  memoryGapTaskIds?: readonly string[] | undefined;
  /** Non-get memory reads (search/query/list/…) — noted, never a recovery gap. */
  otherMemoryReads?: ReadonlyArray<{ taskId: string; operationId: string }> | undefined;
  title?: string | undefined;
  notes?: string | undefined;
}): PromotionDraftResult | PromotionRejection {
  const {
    run,
    tasks,
    campaignConfig,
    memoryDocs = [],
    memoryGapTaskIds = [],
    otherMemoryReads = [],
  } = params;

  if (run.status === 'cancelled') {
    return {
      ok: false,
      code: 'run_cancelled',
      detail:
        'A cancelled run encodes an operator decision, not skill behavior — there is nothing to promote.',
    };
  }
  if (!TERMINAL_STATUSES.has(run.status)) {
    return {
      ok: false,
      code: 'run_not_terminal',
      detail: `Run '${run.runId}' is '${run.status}' — only terminal runs (completed/paused/failed) carry observed behavior to promote.`,
    };
  }

  const mined: string[] = [];
  const missing: string[] = [];

  // --- Trigger: validated inputs + instructions + campaign linkage ---
  const metadata = WorkflowRunMetadataSchema.safeParse(run.metadata ?? {});
  const parentTaskInputs = metadata.success ? metadata.data.parentTaskInputs : undefined;
  const inputs = parentTaskInputs?.inputs ?? {};
  if (parentTaskInputs) {
    mined.push(
      `trigger inputs (${String(Object.keys(inputs).length)} keys, validated at start for task '${parentTaskInputs.taskId}')`,
    );
  } else {
    missing.push('trigger inputs — the run recorded no parentTaskInputs; supply them by hand');
  }

  let instructions: TaskTargetedInstructions | undefined;
  const storedInstructions = metadata.success ? metadata.data.parentInstructions : undefined;
  if (storedInstructions) {
    instructions =
      'runLevel' in storedInstructions
        ? storedInstructions.runLevel
        : storedInstructions.taskTargeted;
    mined.push('run instructions');
  }

  let campaignConfigOut: Record<string, unknown> | undefined;
  if (run.campaignId != null) {
    const parsedConfig = CampaignConfigRecordSchema.safeParse(campaignConfig ?? {});
    if (campaignConfig !== undefined && parsedConfig.success) {
      campaignConfigOut = parsedConfig.data;
      mined.push('campaign config');
    } else if (campaignConfig !== undefined) {
      missing.push('campaign config — the stored config does not fit the record shape');
    } else {
      missing.push('campaign config — the campaign row was not readable');
    }
  }

  // --- Terminal expectation: the OBSERVED terminal state, operator-edited ---
  const expectations: CaseExpectation[] = [];
  if (run.status === 'paused') {
    const pausedReason = WorkflowRunPauseReasonSchema.safeParse(run.pausedReason);
    const pausedTask = tasks.find((t) => t.status === 'paused');
    expectations.push({
      kind: 'terminal',
      runStatus: 'paused',
      ...(pausedReason.success ? { pausedReason: pausedReason.data } : {}),
      ...(pausedTask ? { pausedTaskId: pausedTask.taskId } : {}),
    });
    mined.push(
      `terminal state: paused${pausedReason.success ? ` (${pausedReason.data})` : ''}${pausedTask ? ` at task '${pausedTask.taskId}'` : ''}`,
    );
    if (!pausedReason.success) {
      missing.push('paused reason — the run carries none the pause vocabulary recognizes');
    }
  } else {
    expectations.push({
      kind: 'terminal',
      runStatus: run.status as 'completed' | 'failed',
    });
    mined.push(`terminal state: ${run.status}`);
  }

  // --- Fixture: mined memory reads, learnings pinned off (stationarity) ---
  if (memoryDocs.length > 0) {
    mined.push(`${String(memoryDocs.length)} memory doc(s) the run actually read`);
  }
  const gapNotes: string[] = [];
  for (const taskId of memoryGapTaskIds) {
    gapNotes.push(`memory read of task '${taskId}' could not be recovered into the fixture`);
  }
  for (const read of otherMemoryReads) {
    gapNotes.push(
      `task '${read.taskId}' read memory via ${read.operationId} — result sets are not ` +
        `reproducible as fixture docs; seed equivalent docs if the case depends on them`,
    );
  }
  if (gapNotes.length > 0) missing.push(...gapNotes);

  // --- Provenance: reference output vs counterexample ---
  const lastOutput = selectReferenceOutputTask(tasks);

  const provenance: CaseProvenance = {
    source: 'promoted_from_run',
    runId: run.runId,
    runStatus: run.status as 'completed' | 'paused' | 'failed',
    workflowRevision: run.workflowRevision,
  };
  if (run.status === 'completed') {
    if (lastOutput?.outputRef != null) {
      provenance.referenceOutputRef = lastOutput.outputRef;
      mined.push(`reference output (task '${lastOutput.taskId}')`);
    } else {
      missing.push('reference output — no task output payload survived');
    }
  } else if (run.status === 'failed') {
    const failedTask = tasks.find((t) => t.status === 'failed');
    const counterexampleRef = run.failureRef ?? lastOutput?.outputRef ?? undefined;
    if (counterexampleRef !== undefined) {
      provenance.counterexample = {
        outputRef: counterexampleRef,
        critique:
          params.notes ??
          failedTask?.failureReason ??
          'Observed failure captured at promotion — critique it during ratification.',
      };
      mined.push('counterexample (the observed wrong behavior this case exists to prevent)');
    } else {
      missing.push('counterexample output — the run left no failure payload and no task output');
    }
  }

  const noteLines = [
    ...(params.notes !== undefined ? [params.notes] : []),
    ...gapNotes.map((gap) => `Gap: ${gap}.`),
  ];
  const notes = noteLines.join('\n').slice(0, 2000);

  const direction = run.status === 'paused' ? 'should_pause' : 'should_succeed';
  // A failure promotion has no solvability evidence yet — the failed run is
  // the counterexample. It enters at capability tier (allowed to be red)
  // until the fix lands and a passing run graduates it to regression.
  const tier = run.status === 'failed' ? 'capability' : 'regression';

  const content = GoldenCaseContentSchema.parse({
    title: (params.title ?? `Promoted from ${run.status} run ${run.runId}`).slice(0, 200),
    ...(notes.length > 0 ? { notes } : {}),
    stratum: { scenario: 'unclassified', direction, tier },
    trigger: {
      inputs,
      ...(instructions !== undefined ? { instructions } : {}),
      ...(run.campaignId != null ? { campaignId: run.campaignId } : {}),
      ...(campaignConfigOut !== undefined ? { campaignConfig: campaignConfigOut } : {}),
    },
    fixture: {
      tier: 'seeded',
      ...(memoryDocs.length > 0 ? { memoryDocs: [...memoryDocs] } : {}),
      learnings: 'none',
    },
    expectations,
    rubrics: [],
    provenance,
  });

  return { ok: true, content, mined, missing };
}
