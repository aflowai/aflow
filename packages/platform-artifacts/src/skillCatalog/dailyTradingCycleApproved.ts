/**
 * The approved set: the reviewed theses a Daily Trading Cycle may open. A
 * review writes one document per trading day, keyed by slot. The decide
 * contract refuses any thesis that does not instantiate an approved entry of
 * its own (tradingDay, slot), and a slot with none opens nothing. Resolution
 * of theses already open reads nothing here.
 */
import { z } from 'zod';
import {
  CYCLE_SLOTS,
  SLOT_INDEX_SCHEMA,
  SLOT_KEY_PATTERN,
  type CycleSlot,
} from './dailyTradingCycleSlots.js';

export const APPROVED_THESES_VALIDATOR_REF = 'trading.approved-theses' as const;

export const APPROVED_THESES_PATH_TEMPLATE = '/research/{tradingDay}/approved-theses.json';

export function approvedThesesPath(tradingDay: string): string {
  return APPROVED_THESES_PATH_TEMPLATE.replace('{tradingDay}', tradingDay);
}

export function slotKeyOf(slot: CycleSlot, slotIndex: number | null): string {
  return slot === 'intraday' ? `intraday-${String(slotIndex)}` : slot;
}

export const APPROVED_ID_PATTERN = '^[a-z0-9][a-z0-9-]{2,63}$';
const TRADING_DAY_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

/** Only `approved` entries may be opened. The others record what the review turned down. */
export const REVIEWER_VERDICTS = ['approved', 'revise', 'rejected'] as const;

/**
 * One reviewed thesis. Unknown fields pass through, so a field a later plan
 * adds does not invalidate a set written before it. `hypothesisId` is
 * optional until campaigns name their hypotheses.
 */
export const ApprovedThesisSchema = z
  .object({
    approvedId: z.string().regex(new RegExp(APPROVED_ID_PATTERN)),
    instrument: z.string().min(1),
    direction: z.enum(['long', 'short']),
    hypothesisId: z.string().min(1).optional(),
    entryLevel: z.number().positive(),
    invalidationLevel: z.number().positive(),
    confirmationLevel: z.number().positive(),
    maxSizePct: z.number().positive(),
    horizonTradingDays: z.number().int().min(1),
    reviewerVerdict: z.enum(REVIEWER_VERDICTS),
    reviewRunId: z.string().min(1),
  })
  .passthrough();

export const ApprovedThesisSetSchema = z
  .object({
    tradingDay: z.string().regex(new RegExp(TRADING_DAY_PATTERN)),
    slots: z.record(
      z.string().regex(new RegExp(`^${SLOT_KEY_PATTERN}$`)),
      z.array(ApprovedThesisSchema),
    ),
  })
  .passthrough()
  .superRefine((set, ctx) => {
    for (const [slotKey, entries] of Object.entries(set.slots)) {
      const seen = new Set<string>();
      entries.forEach((entry, i) => {
        if (seen.has(entry.approvedId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['slots', slotKey, i, 'approvedId'],
            message: `approvedId "${entry.approvedId}" appears twice under ${slotKey}.`,
          });
        }
        seen.add(entry.approvedId);
      });
    }
  });

export type ApprovedThesis = z.infer<typeof ApprovedThesisSchema>;

// ── Contract fragments the cycle's tasks spread into their schemas ─────────

/** decide names its cycle, so the approved-set rule can find the set for it. */
export const DECIDE_IDENTITY_PROPERTIES = {
  tradingDay: {
    type: 'string',
    pattern: TRADING_DAY_PATTERN,
    description: 'This cycle’s trading day, copied from your input. It is pinned.',
  },
  slotIndex: {
    ...SLOT_INDEX_SCHEMA,
    description: 'This cycle’s intraday firing number, copied from your input. It is pinned.',
  },
};

export const DECIDE_IDENTITY_PINS = [
  {
    bindingId: 'decide-trading-day-pin',
    from: 'resolve-theses',
    binding: 'value:$.tradingDay',
    target: '$.tradingDay.const',
  },
  {
    bindingId: 'decide-slot-index-pin',
    from: 'resolve-theses',
    binding: 'value:$.slotIndex',
    target: '$.slotIndex.const',
  },
];

export const THESIS_APPROVAL_PROPERTIES = {
  approvedId: {
    type: 'string',
    pattern: APPROVED_ID_PATTERN,
    description: `The approved-set entry this thesis instantiates, from ${APPROVED_THESES_PATH_TEMPLATE} under this cycle’s slotKey. An id the set does not hold with verdict approved is refused.`,
  },
  reviewRunId: {
    type: 'string',
    minLength: 1,
    description: 'The review run id on that entry, copied verbatim.',
  },
};

export const ORDER_APPROVAL_PROPERTY = {
  approvedId: {
    type: ['string', 'null'],
    description:
      'The approvedId of the thesis behind an entry, also stored on its intention doc. null on a close.',
  },
};

/**
 * An entry reaches the broker only for a thesis that carries an approvedId.
 * An expired entry intention may lack one: it is dropped, never submitted.
 */
export const ORDER_APPROVAL_RULES = [
  {
    properties: {
      orderResults: {
        items: {
          if: {
            required: ['intent', 'disposition'],
            properties: {
              intent: { const: 'open' },
              disposition: { enum: ['submitted', 'duplicate', 'deferred', 'failed'] },
            },
          },
          then: { properties: { approvedId: { type: 'string', pattern: APPROVED_ID_PATTERN } } },
        },
      },
    },
  },
  {
    properties: {
      orderResults: {
        items: {
          if: { required: ['intent'], properties: { intent: { const: 'close' } } },
          then: { properties: { approvedId: { type: 'null' } } },
        },
      },
    },
  },
];

/** The cycle doc names the approval behind every thesis it opened. */
export const OPENED_APPROVALS_SCHEMA = {
  openedApprovals: {
    type: 'array',
    description: 'One entry per thesis this cycle opened: its approvedId and review run id.',
    items: {
      type: 'object',
      required: ['thesisId', 'approvedId', 'reviewRunId'],
      additionalProperties: false,
      properties: {
        thesisId: { type: 'string' },
        approvedId: { type: 'string', pattern: APPROVED_ID_PATTERN },
        reviewRunId: { type: 'string', minLength: 1 },
      },
    },
  },
};

export const OPENED_APPROVALS_PINS = [
  {
    bindingId: 'opened-approvals-floor',
    from: 'decide',
    binding: 'count:$.theses',
    target: '$.cycleDoc.openedApprovals.minItems',
  },
  {
    bindingId: 'opened-approvals-ceiling',
    from: 'decide',
    binding: 'count:$.theses',
    target: '$.cycleDoc.openedApprovals.maxItems',
  },
];

// ── The rule ───────────────────────────────────────────────────────────────

export type ApprovedSetRead =
  | { status: 'missing' }
  | { status: 'unreadable'; reason: string }
  | { status: 'found'; content: unknown };

export interface ApprovedThesesIssue {
  path: Array<string | number>;
  message: string;
}

const DecideApprovalViewSchema = z
  .object({
    tradingDay: z.string(),
    slot: z.enum(CYCLE_SLOTS),
    slotIndex: z.number().int().nullable(),
    theses: z.array(
      z
        .object({
          approvedId: z.string(),
          reviewRunId: z.string(),
          instrument: z.string(),
          direction: z.string(),
          sizePct: z.number(),
          deadlineTradingDays: z.number(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

type DecidedThesis = z.infer<typeof DecideApprovalViewSchema>['theses'][number];

function resolveOnly(where: string, why: string): ApprovedThesesIssue[] {
  return [
    {
      path: ['theses'],
      message: `${why}, so ${where} is a resolve-only cycle. Submit theses: [] and say so in decisionRationale.`,
    },
  ];
}

function entryMismatches(
  thesis: DecidedThesis,
  entry: ApprovedThesis,
  i: number,
): ApprovedThesesIssue[] {
  const issues: ApprovedThesesIssue[] = [];
  const at = (field: string, message: string) => {
    issues.push({ path: ['theses', i, field], message });
  };
  const id = entry.approvedId;
  if (thesis.instrument !== entry.instrument) {
    at('instrument', `is ${thesis.instrument}, but approved entry ${id} is ${entry.instrument}.`);
  }
  if (thesis.direction !== entry.direction) {
    at('direction', `is ${thesis.direction}, but approved entry ${id} is ${entry.direction}.`);
  }
  if (thesis.sizePct > entry.maxSizePct) {
    at(
      'sizePct',
      `is ${String(thesis.sizePct)}, over the ${String(entry.maxSizePct)} that ${id} allows.`,
    );
  }
  if (thesis.deadlineTradingDays > entry.horizonTradingDays) {
    at(
      'deadlineTradingDays',
      `is ${String(thesis.deadlineTradingDays)}, past the ${String(entry.horizonTradingDays)}-day horizon that ${id} allows.`,
    );
  }
  if (thesis.reviewRunId !== entry.reviewRunId) {
    at('reviewRunId', `is "${thesis.reviewRunId}", but ${id} carries "${entry.reviewRunId}".`);
  }
  return issues;
}

/**
 * Every thesis decide opens must instantiate an approved entry of the set for
 * its (tradingDay, slot). `read` loads the set document by path. A decision
 * that opens nothing never reads it.
 */
export async function approvedThesesIssues(
  output: unknown,
  read: (path: string) => Promise<ApprovedSetRead>,
): Promise<ApprovedThesesIssue[]> {
  const view = DecideApprovalViewSchema.safeParse(output);
  if (!view.success) {
    return [{ path: [], message: 'The output does not carry the cycle identity and theses.' }];
  }
  const { tradingDay, slot, slotIndex, theses } = view.data;
  if (theses.length === 0) return [];

  const path = approvedThesesPath(tradingDay);
  const slotKey = slotKeyOf(slot, slotIndex);
  const where = `(${tradingDay}, ${slotKey})`;
  const doc = await read(path);
  if (doc.status === 'missing') return resolveOnly(where, `No approved set exists at ${path}`);
  if (doc.status === 'unreadable') {
    return resolveOnly(where, `The approved set at ${path} cannot be read (${doc.reason})`);
  }
  const set = ApprovedThesisSetSchema.safeParse(doc.content);
  if (!set.success) {
    const first = set.error.issues[0];
    const detail = first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'invalid';
    return resolveOnly(where, `The approved set at ${path} does not parse (${detail})`);
  }
  if (set.data.tradingDay !== tradingDay) {
    return resolveOnly(where, `The approved set at ${path} is for ${set.data.tradingDay}`);
  }
  const approved = new Map(
    (set.data.slots[slotKey] ?? [])
      .filter((e) => e.reviewerVerdict === 'approved')
      .map((e) => [e.approvedId, e]),
  );
  if (approved.size === 0) {
    return resolveOnly(where, `The approved set at ${path} approves nothing for ${slotKey}`);
  }

  const issues: ApprovedThesesIssue[] = [];
  const cited = new Set<string>();
  theses.forEach((thesis, i) => {
    const entry = approved.get(thesis.approvedId);
    if (!entry) {
      issues.push({
        path: ['theses', i, 'approvedId'],
        message: `"${thesis.approvedId}" is not an approved entry of the set for ${where}. It approves: ${[...approved.keys()].join(', ')}. Instantiate one of them or drop this thesis.`,
      });
      return;
    }
    if (cited.has(entry.approvedId)) {
      issues.push({
        path: ['theses', i, 'approvedId'],
        message: `"${entry.approvedId}" is already instantiated by an earlier thesis of this output. One approved entry opens one thesis.`,
      });
    }
    cited.add(entry.approvedId);
    issues.push(...entryMismatches(thesis, entry, i));
  });
  return issues;
}
