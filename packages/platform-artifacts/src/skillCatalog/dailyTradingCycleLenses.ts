/**
 * The review lenses as the thesis ledger records them (Plan 343 Part C). The
 * Strategy Desk reviews each candidate through six lenses, each its own run,
 * and every approved entry carries what each lens said. The thesis that
 * instantiates the entry copies it, so its resolution sits beside the lens
 * verdicts it was opened under. That is the data the eval plane needs to ask
 * whether a lens's rejection rate predicts falsification. This module records
 * the data and the criterion. It computes no answer.
 */
import { z } from 'zod';

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

/** The registered runtime validator that holds lensRecordGaps to the records the cycle held. */
export const LENS_RECORD_VALIDATOR_REF = 'trading.lens-record' as const;

const LensRoundRecordSchema = z
  .object({
    round: z.number().int().min(1),
    verdict: z.enum(REVIEWER_VERDICTS),
    reason: z.string(),
  })
  .strict();

const LensFindingRecordSchema = z
  .object({
    verdict: z.enum(REVIEWER_VERDICTS),
    reason: z.string(),
    rounds: z.array(LensRoundRecordSchema),
  })
  .strict();

/** A desk lens record, the shape LENS_RECORD_SCHEMA describes. Any other value is not one. */
const LensRecordSchema = z
  .record(LensFindingRecordSchema)
  .refine(
    (record) =>
      Object.keys(record).length === DESK_LENSES.length &&
      DESK_LENSES.every((lens) => lens in record),
    { message: 'A lens record holds one finding for each of the six lenses, and nothing else.' },
  );

export function isLensRecord(value: unknown): boolean {
  return LensRecordSchema.safeParse(value).success;
}

/** 1 when this cycle dropped a lens record it held, else 0. */
export const RECORD_LENS_GAP_METRIC = {
  lensRecordGaps: {
    type: 'integer',
    minimum: 0,
    maximum: 1,
    description:
      '1 when a thesis this cycle opened or resolved lost the lens record it held, else 0. A thesis opened from an entry with no lens record, as on a set the operator wrote, or opened before lens records, holds none: it is not applicable and counts no gap.',
  },
};

const RecordLensViewSchema = z
  .object({
    lensRecordGaps: z.unknown(),
    cycleDoc: z
      .object({
        tradingDay: z.string(),
        slot: z.string(),
        slotIndex: z.number().int().nullable(),
        openedApprovals: z
          .array(z.object({ thesisId: z.string(), approvedId: z.string() }).passthrough())
          .default([]),
        thesesResolved: z.array(z.object({ thesisId: z.string() }).passthrough()).default([]),
      })
      .passthrough(),
  })
  .passthrough();

export interface LensRecordSources {
  /** The approved set's entries for this cycle's slot, as the set holds them now. */
  entries: ReadonlyArray<Record<string, unknown>>;
  /** Each resolved thesis's lenses value, by thesisId, from its resolved ledger doc. */
  resolvedLenses: ReadonlyMap<string, unknown>;
}

export interface LensRecordIssue {
  path: Array<string | number>;
  message: string;
}

/**
 * Where the cycle dropped a lens record it held. An opened thesis held the
 * record its approved entry carries, and a resolved thesis the record its
 * ledger doc carries. A thesis that held none is not applicable.
 */
export function droppedLensRecords(output: unknown, sources: LensRecordSources): string[] | null {
  const view = RecordLensViewSchema.safeParse(output);
  if (!view.success) return null;
  const { openedApprovals, thesesResolved } = view.data.cycleDoc;
  const byApproval = new Map(sources.entries.map((e) => [e['approvedId'], e['lenses']]));
  const dropped = (held: unknown, carried: unknown) =>
    isLensRecord(held) && canonicalJson(carried ?? null) !== canonicalJson(held);
  return [
    ...openedApprovals
      .filter((item) => dropped(byApproval.get(item.approvedId), item['lenses']))
      .map(
        (item) => `opened thesis ${item.thesisId} lost the lens record of entry ${item.approvedId}`,
      ),
    ...thesesResolved
      .filter((item) => dropped(sources.resolvedLenses.get(item.thesisId), item['lenses']))
      .map(
        (item) => `resolved thesis ${item.thesisId} lost the lens record its ledger doc carries`,
      ),
  ];
}

/** lensRecordGaps must say whether this cycle dropped a record it held. */
export function lensRecordGapIssues(
  output: unknown,
  sources: LensRecordSources,
): LensRecordIssue[] {
  const view = RecordLensViewSchema.safeParse(output);
  const drops = droppedLensRecords(output, sources);
  if (!view.success || drops === null) {
    return [{ path: [], message: 'The output does not carry a cycle doc with its theses.' }];
  }
  const expected = drops.length > 0 ? 1 : 0;
  if (view.data.lensRecordGaps === expected) return [];
  return [
    {
      path: ['lensRecordGaps'],
      message:
        expected === 0
          ? 'must be 0: no thesis this cycle lost a lens record it held. A thesis that held none is not applicable.'
          : `must be 1: ${drops.join(', ')}. Copy each record verbatim and set 0, or keep 1.`,
    },
  ];
}

/**
 * The eval plane's criterion, scoped to what one cycle run holds. A cycle sees
 * its own theses, not the window, so it cannot compare rates. It scores that
 * the cycle kept every lens record it held, which the window comparison reads.
 * The comparison itself is the lens-predictiveness goal, read over the window.
 */
export const LENS_RECORD_CARRIED_CRITERION = {
  name: 'lens-record-carried',
  type: 'threshold' as const,
  metric: 'lensRecordGaps',
  operator: 'lte' as const,
  target: 0,
};
