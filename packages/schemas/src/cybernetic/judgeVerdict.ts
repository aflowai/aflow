import { z } from 'zod';

import { JUDGE_CRITERION_MAX_CHARS } from './eval.js';
import { cappedText } from '../modelOutput/cappedText.js';

/**
 * The structured output a Judge LLM call must produce (Plan 269 D8).
 *
 * The judge answers each rubric entry SEPARATELY. A single verdict over a
 * multi-entry rubric collapses into a paragraph arguing with itself — "entry 1
 * is met, entry 2 is not" — so the reader has to parse prose to learn which
 * half failed, and a calibration label covers a bundle rather than a claim.
 * Per-entry answers make the failing criterion a field, countable across a
 * batch and labellable on its own.
 *
 * Field order within an entry is load-bearing: `rationale` precedes `verdict`
 * so the model reasons before committing (critique-then-verdict). Reordering
 * the keys changes what the judge does.
 *
 * The overall `verdict` and `score` are DERIVED from the entries rather than
 * asked for: a model asked for both can contradict itself, and there is no
 * honest way to resolve that afterwards.
 */
/** How many entries a judge answers — one per rubric entry, and the rubric's own cap. */
export const JUDGE_MAX_RUBRIC_ENTRIES = 5;

/** How long one entry's critique may be. Exported so a token budget can derive from it. */
export const JUDGE_ENTRY_RATIONALE_MAX_CHARS = 2000;

export const JudgeVerdictEntrySchema = z.object({
  /** The rubric entry's criterion, echoed so entries can be matched to it. */
  criterion: z.string().min(1).max(JUDGE_CRITERION_MAX_CHARS),
  rationale: cappedText(
    JUDGE_ENTRY_RATIONALE_MAX_CHARS,
    'The critique for this entry, citing what drove it.',
  ),
  /**
   * `pass` and `fail` are the judgements; `unclear` is the abstention.
   *
   * Binary verdicts are what make precision/recall well-defined, so the
   * abstention is kept OUT of the score rather than treated as a third grade —
   * graded nuance still belongs in the operator's label critique. It exists
   * because a judge that must answer on evidence it cannot read answers
   * anyway, and a coin-flip recorded as a verdict is worse than a gap that
   * says so.
   */
  verdict: z.enum(['pass', 'fail', 'unclear']),
});
export type JudgeVerdictEntry = z.infer<typeof JudgeVerdictEntrySchema>;

/**
 * Providers differ on how a nested array comes back: some hand over the array,
 * some hand over its JSON text. Parsing the string here costs nothing and
 * saves a whole judgement, which would otherwise be thrown away over a
 * serialisation detail the judge has no control over.
 */
const entriesFromModel = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}, z.array(JudgeVerdictEntrySchema).min(1).max(JUDGE_MAX_RUBRIC_ENTRIES));

export const JudgeVerdictSchema = z.object({
  entries: entriesFromModel,
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

/**
 * The judge's answers aligned to the rubric that was ASKED, not to the list it
 * happened to return.
 *
 * A model that omits an entry would otherwise fold to a pass on the entries it
 * chose to answer — the failing criterion simply disappears. So an unanswered
 * entry is a `fail` carrying its own reason, a duplicate answer is taken once,
 * and anything answered that was never asked is dropped.
 */
/**
 * How a returned criterion name is matched to the one that was asked.
 *
 * Exact string equality fails on punctuation the model normalises. A rubric
 * written with a typographic apostrophe comes back with a straight one, the
 * answer finds no home, and the criterion is recorded as unanswered — turning
 * a judgement the model actually made into a missing one. Quotes, dashes and
 * runs of whitespace are folded for the comparison only; the rubric's own text
 * is untouched.
 */
function criterionKey(criterion: string): string {
  return criterion
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ');
}

export function alignJudgeEntries(
  asked: ReadonlyArray<{ criterion: string }>,
  verdict: JudgeVerdict,
): JudgeVerdictEntry[] {
  const answered = new Map<string, JudgeVerdictEntry>();
  for (const entry of verdict.entries) {
    const key = criterionKey(entry.criterion);
    if (!answered.has(key)) answered.set(key, entry);
  }
  return asked.map(
    (rubricEntry) =>
      answered.get(criterionKey(rubricEntry.criterion)) ?? {
        criterion: rubricEntry.criterion,
        rationale: 'The judge returned no answer for this criterion.',
        // Unanswered is the JUDGE failing to answer, not the subject failing
        // the criterion. While verdicts were advisory the difference cost
        // nothing; now that they gate, scoring it `fail` would fail a trial for
        // its judge's omission.
        verdict: 'unclear' as const,
      },
  );
}

/** A rubric passes only when every entry does; the score is the share that did. */
export function foldJudgeVerdict(entries: readonly JudgeVerdictEntry[]): {
  verdict: 'pass' | 'fail' | 'unclear';
  score: number;
  rationale: string;
} {
  const passed = entries.filter((entry) => entry.verdict === 'pass').length;
  const failed = entries.filter((entry) => entry.verdict === 'fail').length;
  // A definitive failure outranks an abstention elsewhere, the same ordering
  // the trial fold uses: one entry the judge could not read does not retract
  // another it answered plainly.
  const verdict =
    entries.length === 0
      ? 'unclear'
      : failed > 0
        ? 'fail'
        : passed === entries.length
          ? 'pass'
          : 'unclear';
  // Over what the judge ANSWERED. Counting abstentions in the denominator
  // drags the score down for evidence the judge could not read, which is the
  // same conflation the trial fold removes — a missing measurement reported as
  // a bad result. What stops a partly-judged criterion reading as a clean one
  // is the verdict beside it: `unclear` carries to `quality_unverified`, which
  // is excluded from the behavioural score and counted on its own.
  const answered = passed + failed;
  return {
    verdict,
    score: answered === 0 ? 0 : passed / answered,
    rationale: entries
      .map((entry) => `${entry.criterion} — ${entry.verdict}: ${entry.rationale}`)
      .join('\n\n')
      .slice(0, 1500),
  };
}
