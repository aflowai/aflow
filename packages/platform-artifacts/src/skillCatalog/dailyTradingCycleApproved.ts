/**
 * The approved set: the reviewed theses a Daily Trading Cycle may open. The
 * operator, or a review run outside the cycle, writes one document per
 * trading day, keyed by slot. The decide contract refuses any thesis that
 * does not instantiate an approved entry of its own (tradingDay, slot), and a
 * slot with none opens nothing. Resolution of theses already open reads
 * nothing here.
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
 * adds does not invalidate a set written before it. `hypothesisId` names the
 * campaign arm the review approved it under, and the thesis cites the same.
 */
export const ApprovedThesisSchema = z
  .object({
    approvedId: z.string().regex(new RegExp(APPROVED_ID_PATTERN)),
    instrument: z.string().min(1),
    direction: z.enum(['long', 'short']),
    hypothesisId: z.string().min(1),
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
  // A set fault the decision named lands on the cycle doc unchanged.
  {
    bindingId: 'cycle-doc-set-fault-pin',
    from: 'decide',
    binding: 'value:$.approvedSetFault',
    target: '$.cycleDoc.approvedSetFault.const',
  },
];

const SET_FAULT_SCHEMA = { type: ['string', 'null'], maxLength: 4000 };

/**
 * A bad set opens nothing but stops nothing either. decide names the fault,
 * the cycle doc records it, and record scores it, so the operator sees it on
 * every cycle until the set is repaired.
 */
export const DECIDE_SET_FAULT_PROPERTY = {
  approvedSetFault: {
    ...SET_FAULT_SCHEMA,
    description:
      'null when the approved set reads cleanly or does not exist. When the contract reports the set cannot be read, does not parse or comes from a refused writer, the fault sentence it quotes, verbatim.',
  },
};

export const CYCLE_DOC_SET_FAULT_PROPERTY = {
  approvedSetFault: {
    ...SET_FAULT_SCHEMA,
    description: 'The approved-set fault decide named, or null.',
  },
};

/** 1 when this cycle's approved set was faulted, else 0. The eval criterion below scores it. */
export const RECORD_SET_FAULT_METRIC = {
  approvedSetFaults: { type: 'integer', minimum: 0, maximum: 1 },
};

export const RECORD_SET_FAULT_RULES = [
  {
    if: {
      required: ['cycleDoc'],
      properties: {
        cycleDoc: {
          required: ['approvedSetFault'],
          properties: { approvedSetFault: { type: 'string' } },
        },
      },
    },
    then: { properties: { approvedSetFaults: { const: 1 } } },
    else: { properties: { approvedSetFaults: { const: 0 } } },
  },
];

export const APPROVED_SET_SOUND_CRITERION = {
  name: 'approved-set-sound',
  type: 'threshold' as const,
  metric: 'approvedSetFaults',
  operator: 'lte' as const,
  target: 0,
};

// ── The rule ───────────────────────────────────────────────────────────────

/** The workflow slug of the cycle. A set any run of it wrote approves nothing. */
export const CYCLE_WORKFLOW_SLUG = 'daily-trading-cycle';

/**
 * Who wrote the set's current version, as the platform recorded it. The
 * memory store derives provenance from the executing step and never takes it
 * from the caller, so no agent can name another writer.
 */
export type ApprovedSetWriter =
  /** A write with no session behind it: the operator, through Memory or the API. */
  | { kind: 'operator'; actor: string }
  /** A write from inside an execution: an agent session, or a task's step. */
  | {
      kind: 'session';
      /** The session of record. */
      sessionId: string | null;
      /** The step execution of record. An operation task's step executes as its worker. */
      stepExecutionId: string | null;
      /**
       * Runs this session drove: the conversation that started or steers them.
       * Driving a run does not make a session its writer.
       */
      drivenRuns: string[];
      /** Every run with a task that executed as this writer, sorted by runId. */
      runs: ApprovedSetWriterRun[];
    };

export interface ApprovedSetWriterRun {
  runId: string;
  workflowSlug: string;
  status: string;
  spaceId: string;
}

export type ApprovedSetRead =
  | { status: 'missing' }
  | { status: 'unreadable'; reason: string }
  | { status: 'found'; content: unknown; writer: ApprovedSetWriter };

export interface ApprovedThesesIssue {
  path: Array<string | number>;
  message: string;
}

/**
 * Approval holds only when it comes from outside the cycle: the operator, or
 * one task of one completed review run of another skill in this space, whose
 * id every approved entry names. The writer must be the task's own execution.
 * A conversation that drove a run is refused whatever runs it drove, so an
 * agent conversation cannot approve theses in a run's name. A set any cycle
 * run wrote is refused, so no cycle task can approve its own theses.
 */
export function approvedSetWriterRefusal(
  writer: ApprovedSetWriter,
  entries: readonly ApprovedThesis[],
  spaceId: string,
): string | null {
  if (writer.kind === 'operator') return null;
  const who = `session ${writer.sessionId ?? '(none)'}`;
  if (writer.drivenRuns.length > 0) {
    return `was written by ${who}, the conversation that drives run ${writer.drivenRuns.join(', ')}. A conversation is never a run's writer, so it cannot approve theses`;
  }
  if (writer.runs.length === 0) {
    return `was written by ${who}, which is the execution of no workflow run's task. Only the operator or a completed review run may write it`;
  }
  if (writer.runs.length > 1) {
    return `was written by ${who}, which is tied to ${String(writer.runs.length)} runs (${writer.runs.map((r) => r.runId).join(', ')}). One review run must write it`;
  }
  const run = writer.runs[0]!;
  if (run.workflowSlug === CYCLE_WORKFLOW_SLUG) {
    return `was written by ${CYCLE_WORKFLOW_SLUG} run ${run.runId}. A cycle cannot approve its own theses`;
  }
  if (run.spaceId !== spaceId) {
    return `was written by run ${run.runId} of another space`;
  }
  if (run.status !== 'completed') {
    return `was written by ${run.workflowSlug} run ${run.runId}, which is ${run.status}, not completed`;
  }
  const stray = entries.find((e) => e.reviewRunId !== run.runId);
  if (stray) {
    return `was written by review run ${run.runId}, but entry ${stray.approvedId} names review run ${stray.reviewRunId}`;
  }
  return null;
}

const DecideApprovalViewSchema = z
  .object({
    tradingDay: z.string(),
    slot: z.enum(CYCLE_SLOTS),
    slotIndex: z.number().int().nullable(),
    approvedSetFault: z.string().nullable(),
    theses: z.array(
      z
        .object({
          approvedId: z.string(),
          reviewRunId: z.string(),
          hypothesisId: z.string(),
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

/**
 * A set that cannot be read, does not parse or comes from a refused writer
 * approves nothing, and the output must say so in `approvedSetFault`. The
 * fault gates new theses only: decide still submits, so this cycle's closes
 * and its record run. Pausing instead would hold the cycle's one run slot,
 * and every later cycle would stop resolving too.
 */
function faulted(
  path: string,
  why: string,
  theses: readonly unknown[],
  declared: string | null,
): ApprovedThesesIssue[] {
  const fault = `The approved set at ${path} ${why}`;
  const issues: ApprovedThesesIssue[] = [];
  if (theses.length > 0) {
    issues.push({
      path: ['theses'],
      message: `${fault}. It approves nothing, so no thesis opens this cycle. Submit theses: [] and copy this fault into approvedSetFault. Resolution and closes run as usual.`,
    });
  }
  if (declared === null || declared.trim() === '') {
    issues.push({
      path: ['approvedSetFault'],
      message: `${fault}. Set approvedSetFault to that sentence, so the cycle doc records the fault for the operator.`,
    });
  }
  return issues;
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
  if (thesis.hypothesisId !== entry.hypothesisId) {
    at(
      'hypothesisId',
      `is "${thesis.hypothesisId}", but approved entry ${id} was approved under arm "${entry.hypothesisId}".`,
    );
  }
  if (thesis.reviewRunId !== entry.reviewRunId) {
    at('reviewRunId', `is "${thesis.reviewRunId}", but ${id} carries "${entry.reviewRunId}".`);
  }
  return issues;
}

export interface ApprovedSetSource {
  /** The space the cycle runs in. A review run of another space approves nothing here. */
  spaceId: string;
  /** Loads the set document by path, with the writer of its current version. */
  read: (path: string) => Promise<ApprovedSetRead>;
}

/**
 * Every thesis decide opens must instantiate an approved entry of the set for
 * its (tradingDay, slot). No set, or none approved for the slot, is a
 * resolve-only cycle. A set that fails to read, parse or come from an
 * accepted writer opens nothing, and the output must name the fault. Only
 * new theses are gated: the rest of the decision passes.
 */
export async function approvedThesesIssues(
  output: unknown,
  source: ApprovedSetSource,
): Promise<ApprovedThesesIssue[]> {
  const view = DecideApprovalViewSchema.safeParse(output);
  if (!view.success) {
    return [{ path: [], message: 'The output does not carry the cycle identity and theses.' }];
  }
  const { tradingDay, slot, slotIndex, theses, approvedSetFault } = view.data;
  const path = approvedThesesPath(tradingDay);
  const slotKey = slotKeyOf(slot, slotIndex);
  const where = `(${tradingDay}, ${slotKey})`;
  const fault = (why: string) => faulted(path, why, theses, approvedSetFault);

  const doc = await source.read(path);
  if (doc.status === 'unreadable') return fault(`cannot be read (${doc.reason})`);
  let entries: ApprovedThesis[] = [];
  if (doc.status === 'found') {
    const set = ApprovedThesisSetSchema.safeParse(doc.content);
    if (!set.success) {
      const first = set.error.issues[0];
      const detail = first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'invalid';
      return fault(`does not parse (${detail})`);
    }
    if (set.data.tradingDay !== tradingDay) {
      return fault(`names tradingDay ${set.data.tradingDay}, not ${tradingDay}`);
    }
    const refusal = approvedSetWriterRefusal(
      doc.writer,
      Object.values(set.data.slots).flat(),
      source.spaceId,
    );
    if (refusal) return fault(refusal);
    entries = set.data.slots[slotKey] ?? [];
  }
  if (approvedSetFault !== null) {
    return [
      {
        path: ['approvedSetFault'],
        message: `The approved set at ${path} has no fault this cycle. Set approvedSetFault to null.`,
      },
    ];
  }

  if (theses.length === 0) return [];
  const approved = new Map(
    entries.filter((e) => e.reviewerVerdict === 'approved').map((e) => [e.approvedId, e]),
  );
  if (doc.status === 'missing') return resolveOnly(where, `No approved set exists at ${path}`);
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
