/**
 * The review lenses as the thesis ledger records them (Plan 343 Part C). The
 * Strategy Desk reviews each candidate through six lenses, each its own run,
 * and every approved entry carries what each lens said. The thesis that
 * instantiates the entry copies it, so its resolution sits beside the lens
 * verdicts it was opened under. That is the data the eval plane needs to ask
 * whether a lens's rejection rate predicts falsification. This module records
 * the data and the criterion. It computes no answer.
 */

/** Only `approved` entries may be opened. The others record what the review turned down. */
export const REVIEWER_VERDICTS = ['approved', 'revise', 'rejected'] as const;

export const DESK_LENSES = [
  'fundamentals',
  'macro',
  'technical',
  'priorLearnings',
  'priorDecisions',
  'risk',
] as const;
export type DeskLens = (typeof DESK_LENSES)[number];

/** JSON with its object keys sorted, so two values compare by content. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec)
      .filter((key) => rec[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(rec[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const LENS_ROUND_RECORD = {
  type: 'object',
  required: ['round', 'verdict', 'reason'],
  additionalProperties: false,
  properties: {
    round: { type: 'integer', minimum: 1 },
    verdict: { enum: [...REVIEWER_VERDICTS] },
    reason: { type: 'string' },
  },
};

/** What each lens said: its verdict and reason in the round that settled, and every round so far. */
export const LENS_RECORD_SCHEMA = {
  type: ['object', 'null'],
  required: [...DESK_LENSES],
  additionalProperties: false,
  properties: Object.fromEntries(
    DESK_LENSES.map((lens) => [
      lens,
      {
        type: 'object',
        required: ['verdict', 'reason', 'rounds'],
        additionalProperties: false,
        properties: {
          verdict: { enum: [...REVIEWER_VERDICTS] },
          reason: { type: 'string' },
          rounds: { type: 'array', items: LENS_ROUND_RECORD },
        },
      },
    ]),
  ),
};

/** decide copies the entry's lens record onto the thesis it opens. */
export const THESIS_LENSES_PROPERTY = {
  lenses: {
    ...LENS_RECORD_SCHEMA,
    description:
      'What each review lens said on the approved entry this thesis instantiates, copied verbatim from the entry’s lenses. null only where the entry carries none, as on a set the operator wrote.',
  },
};

/** The cycle doc carries the lens record beside every thesis it opens and every one it resolves. */
export const RECORDED_LENSES_PROPERTY = {
  lenses: {
    ...LENS_RECORD_SCHEMA,
    description:
      'The lens record on the thesis’s ledger doc, copied verbatim. null where the doc carries none.',
  },
};

/** The question the lens record exists to answer, read over the campaign window. */
export const LENS_PREDICTIVENESS_GOAL = {
  id: 'lens-predictiveness',
  description:
    'Each review lens’s rejection rate, from the lens records, is set against the falsification rate of the filled theses it approved, from their lenses record. It is read over the campaign window, never per cycle.',
};

/** The eval plane's criterion on it. A judge is advisory until measured, so the goal tier keeps weight 0. */
export const LENS_PREDICTIVENESS_CRITERION = {
  name: 'lens-rejection-predicts-falsification',
  type: 'judge' as const,
  rubric: [
    {
      criterion:
        'Per review lens, a higher rejection rate goes with a lower falsification rate among the filled theses that lens approved.',
      scale: 'binary' as const,
      description:
        'Rejection rate: candidates a lens rejected over candidates it reviewed, from /research/{tradingDay}/lens-reviews/. Falsification rate: falsified over confirmed, falsified and expired resolutions, read from each resolved thesis’s lenses record. Answer per lens. Too few resolutions reads unclear.',
    },
  ],
  reads: [{ kind: 'task_summary' as const }],
};
