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

/**
 * decide copies the entry's lens record onto the thesis it opens. The thesis
 * takes whatever the entry holds, so a set the operator wrote with another
 * `lenses` value still opens its thesis. Only the desk's lens records enter the
 * per-lens comparison, and the record step counts a thesis without one.
 */
export const THESIS_LENSES_PROPERTY = {
  lenses: {
    description:
      'What each review lens said on the approved entry this thesis instantiates: the entry’s lenses, copied verbatim, whatever it holds. null where the entry carries none, as on a set the operator wrote.',
  },
};

/** The cycle doc carries the thesis's lens record beside every thesis it opens and every one it resolves. */
export const RECORDED_LENSES_PROPERTY = {
  lenses: {
    description:
      'The lenses value on the thesis’s ledger doc, copied verbatim. null where the doc carries none.',
  },
};

/** The question the lens record exists to answer, read over the campaign window. */
export const LENS_PREDICTIVENESS_GOAL = {
  id: 'lens-predictiveness',
  description:
    'Each review lens’s rejection rate, from the lens records, is set against the falsification rate of the filled theses it approved, from their lenses record. It is read over the campaign window, never per cycle.',
};

/** A thesis whose lenses value is not a desk lens record: it cannot enter the per-lens comparison. */
const WITHOUT_LENS_RECORD = {
  not: { required: ['lenses'], properties: { lenses: { ...LENS_RECORD_SCHEMA, type: 'object' } } },
};

/** 1 when a thesis this cycle opened or resolved carries no lens record, else 0. */
export const RECORD_LENS_GAP_METRIC = {
  lensRecordGaps: { type: 'integer', minimum: 0, maximum: 1 },
};

export const RECORD_LENS_GAP_RULES = [
  {
    if: {
      required: ['cycleDoc'],
      properties: {
        cycleDoc: {
          anyOf: [
            {
              required: ['openedApprovals'],
              properties: { openedApprovals: { contains: WITHOUT_LENS_RECORD } },
            },
            {
              required: ['thesesResolved'],
              properties: { thesesResolved: { contains: WITHOUT_LENS_RECORD } },
            },
          ],
        },
      },
    },
    then: { properties: { lensRecordGaps: { const: 1 } } },
    else: { properties: { lensRecordGaps: { const: 0 } } },
  },
];

/**
 * The eval plane's criterion, scoped to what one cycle run holds. A cycle sees
 * its own theses, not the window, so it cannot compare rates. It scores that
 * every thesis it opened or resolved carries the lens record the window
 * comparison reads. The comparison itself is the lens-predictiveness goal,
 * read over the window.
 */
export const LENS_RECORD_CARRIED_CRITERION = {
  name: 'lens-record-carried',
  type: 'threshold' as const,
  metric: 'lensRecordGaps',
  operator: 'lte' as const,
  target: 0,
};
