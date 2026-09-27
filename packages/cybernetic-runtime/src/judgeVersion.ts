/**
 * Judge identity (Plan 269 D9): `judgeVersion = hash(rubric entries, judge
 * model id, judge prompt template version, evidence pack version)`, computed
 * at read — never persisted as authority (derive-don't-mirror). Persisted
 * VERDICT records carry the judgeVersion they were produced under; scorecards
 * group by it.
 *
 * The evidence version is in here because what a judge is SHOWN decides what
 * it answers as surely as its prompt does. Without it, a change to the pack
 * moves every verdict while the version stays byte-identical, and a
 * calibration measured on the old pack keeps an authority it no longer has —
 * which reads as the subject drifting when it was the ruler.
 */
import type { JudgeRubricEntry } from '@aflow/schemas';
import { stableHash } from '@aflow/schemas';
import { JUDGE_EVIDENCE_VERSION } from './evalJudgeEvidence.js';
import { JUDGE_PROMPT_TEMPLATE_VERSION } from './prompts/judge.js';

export function computeJudgeVersion(
  rubric: readonly JudgeRubricEntry[],
  judgeModelId: string,
  promptTemplateVersion: string = JUDGE_PROMPT_TEMPLATE_VERSION,
  evidenceVersion: string = JUDGE_EVIDENCE_VERSION,
): string {
  return stableHash({ rubric, judgeModelId, promptTemplateVersion, evidenceVersion });
}
