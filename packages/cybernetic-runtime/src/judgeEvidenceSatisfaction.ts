import type { JudgeEvidenceSelector } from '@aflow/schemas';

import type { JudgeEvidence } from './judgeCall.js';

/**
 * Plan 301 §5.4 — whether the pack can answer what a criterion asks.
 *
 * A judge given evidence that does not contain the fact it is asked about does
 * not abstain on its own: it reads the absence as the subject having invented
 * something, and fails a correct answer. That happened across a whole batch
 * before the pack carried tool results, and the verdicts looked like findings.
 *
 * So the criterion declares what it reads, and this decides — before any model
 * call — whether the pack holds it. Unmet means abstain, which costs nothing
 * and says so, rather than a paid verdict nobody should trust.
 */

export interface EvidenceSatisfaction {
  satisfied: boolean;
  /** Human-readable, for the abstention reason a reader sees on the result. */
  missing: string[];
}

function describe(selector: JudgeEvidenceSelector): string {
  switch (selector.kind) {
    case 'reply':
      return 'the subject’s reply';
    case 'tool_result':
      return `what '${selector.endpointId}' returned`;
    case 'task_summary':
      return 'the run’s task summaries';
  }
}

function holds(evidence: JudgeEvidence, selector: JudgeEvidenceSelector): boolean {
  switch (selector.kind) {
    case 'reply':
      return typeof evidence.reply === 'string' && evidence.reply.trim().length > 0;
    case 'tool_result':
      return (evidence.toolResults ?? []).some((r) => r.endpointId === selector.endpointId);
    case 'task_summary':
      return evidence.taskSummaries.length > 0;
  }
}

/**
 * `reads` is `.default([])` on the schema, so a PARSED criterion always has a
 * list — and a criterion that reached here by another path has undefined. The
 * type cannot tell the two apart, and crashing the judge stage over it would
 * cost the whole trial's grading. Absent means the same as empty: reads
 * whatever the pack happens to carry.
 */
export function checkEvidenceSatisfaction(
  evidence: JudgeEvidence,
  reads: readonly JudgeEvidenceSelector[] | undefined,
): EvidenceSatisfaction {
  const missing = (reads ?? []).filter((selector) => !holds(evidence, selector)).map(describe);
  return { satisfied: missing.length === 0, missing };
}
