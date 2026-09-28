import type { JudgeCriterion } from '@aflow/schemas';

// ---------------------------------------------------------------------------
// System prompt (stable — suitable for prompt caching)
// ---------------------------------------------------------------------------

/**
 * Participates in the D9 judge version hash: any change to the prompt
 * template below MUST bump this constant, or verdicts produced under
 * different instructions would share a judgeVersion and poison scorecards.
 */
export const JUDGE_PROMPT_TEMPLATE_VERSION = 'critique-then-verdict-1';

const JUDGE_SYSTEM_PROMPT = `You are a Judge evaluating a skill run against a qualitative rubric. You are strict, consistent, and explicit about your reasoning.

Given:
- A rubric serialized from the criterion's rubric entries.
- Run artifacts (task outputs, task summaries, the final result).
- When present: a known-good reference output. It guides your judgment of what correct looks like — similarity to the reference is never itself scored; grade only against the rubric.
- Any calibration notes from prior operator labels for this rubric.

You must, strictly in this order:
1. Write the rationale FIRST: a critique citing the specific artifact or behavior relevant to each rubric entry, before deciding anything.
2. Only then produce the verdict: 'pass' or 'fail'. There is no partial credit — when the critique shows a rubric entry unmet, the verdict is 'fail'.
3. Produce a numeric score between 0.0 and 1.0 consistent with the verdict.

Do not be charitable. Do not grade on effort. Do not grade relative to other runs.
Grade the work against the rubric, as written.

Answer EVERY rubric entry separately. For each, echo its criterion, give the critique that
drove your answer, then the verdict — in that order, so the reasoning precedes the call.
Judge each entry only against its own description; an entry is not failed because a
different one was. Output JSON matching the JudgeVerdict schema exactly.`;

export function getJudgeSystemPrompt(): string {
  return JUDGE_SYSTEM_PROMPT;
}

// ---------------------------------------------------------------------------
// Rubric formatting
// ---------------------------------------------------------------------------

function formatRubric(rubric: JudgeCriterion['rubric']): string {
  return rubric
    .map(
      (entry: JudgeCriterion['rubric'][number], i: number) =>
        `${String(i + 1)}. [${entry.scale}] ${entry.criterion}\n   ${entry.description}`,
    )
    .join('\n');
}

// ---------------------------------------------------------------------------
// User message builder
// ---------------------------------------------------------------------------

export interface JudgeMessageContext {
  /** The criterion being evaluated. */
  criterion: JudgeCriterion;
  /** Task results from the run (summarised). */
  taskSummaries: Array<{
    taskId: string;
    status: string;
    summary?: string;
  }>;
  /** Full task output payloads (D8 scoped evidence), pre-bounded by the caller. */
  taskOutputs?: Array<{ taskId: string; content: string }>;
  /**
   * What the tools returned to the subject, in call order.
   *
   * Without it a judge can assess coherence but not accuracy: asked whether a
   * reply invented a reference or a date, it has only the reply, and a fact it
   * cannot corroborate reads as a fabrication. Correct answers were failed
   * this way before it existed.
   */
  toolResults?: Array<{ sequence: number; endpointId: string; status: number; body: string }>;
  /**
   * What the subject actually said, for a run that stopped on a pause contract.
   *
   * The same artifact the reply expectations grade. Without it a judge sees
   * only tool JSON, concludes no answer was produced, and scores the criterion
   * against evidence it was never shown.
   */
  reply?: string;
  /**
   * Known-good reference output (reference-guided grading). Guidance only —
   * the prompt states similarity to it is never scored.
   */
  referenceOutput?: string;
  /** Optional final result / outcome summary. */
  finalResult?: string;
  /** Optional calibration notes from prior operator labels. */
  calibrationNotes?: string;
}

/**
 * Builds the user-turn message content for the Judge LLM call.
 * Contains the rubric, run artifacts, and any calibration context.
 */
export function buildJudgeUserMessage(ctx: JudgeMessageContext): string {
  return [
    `## Criterion: ${ctx.criterion.name}`,
    '',
    '## Rubric',
    formatRubric(ctx.criterion.rubric),
    '',
    buildJudgeEvidenceMessage(ctx),
  ].join('\n');
}

/**
 * Everything a judge is shown except the rubric: the reference, the reply, the
 * tool results and the run's artifacts. A decision-model judge reads this as
 * its state and asks each rubric entry as its own question.
 */
export function buildJudgeEvidenceMessage(ctx: JudgeMessageContext): string {
  const parts: string[] = [];

  // Reference answer (if present)
  if (ctx.criterion.referenceAnswer) {
    parts.push('## Reference Answer');
    parts.push(ctx.criterion.referenceAnswer);
    parts.push('');
  }

  if (ctx.referenceOutput !== undefined) {
    parts.push('## Reference Output (guidance only — similarity is never scored)');
    parts.push(ctx.referenceOutput);
    parts.push('');
  }

  // The answer under judgment, ahead of the machinery that produced it.
  if (ctx.reply !== undefined) {
    parts.push('## Reply To The Customer');
    parts.push(ctx.reply);
    parts.push('');
  }

  if (ctx.toolResults !== undefined && ctx.toolResults.length > 0) {
    parts.push('## What The Agent Was Told By Its Tools');
    parts.push(
      'Treat this as the ground truth available to the agent. A fact the reply states that ' +
        'appears here is supported, however specific it sounds.',
    );
    for (const call of ctx.toolResults) {
      parts.push(`### ${String(call.sequence)}. ${call.endpointId} → ${String(call.status)}`);
      parts.push(call.body);
    }
    parts.push('');
  }

  // Run artifacts
  parts.push('## Run Artifacts');
  for (const task of ctx.taskSummaries) {
    const statusLabel = task.status.toUpperCase();
    const summaryText = task.summary ? `: ${task.summary}` : '';
    parts.push(`- Task "${task.taskId}" [${statusLabel}]${summaryText}`);
  }
  parts.push('');

  if (ctx.taskOutputs !== undefined && ctx.taskOutputs.length > 0) {
    parts.push('## Task Outputs');
    for (const output of ctx.taskOutputs) {
      parts.push(`### Task "${output.taskId}"`);
      parts.push(output.content);
    }
    parts.push('');
  }

  if (ctx.finalResult) {
    parts.push('## Final Result');
    parts.push(ctx.finalResult);
    parts.push('');
  }

  // Calibration context
  if (ctx.calibrationNotes) {
    parts.push('## Calibration Notes (from prior operator labels)');
    parts.push(ctx.calibrationNotes);
    parts.push('');
  }

  return parts.join('\n');
}
