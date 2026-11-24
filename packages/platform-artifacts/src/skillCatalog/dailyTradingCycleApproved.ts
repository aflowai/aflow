/**
 * The approved set: the reviewed candidates of one trading day. The Strategy
 * Desk writes it with every candidate, what each lens said and the desk's
 * vetoes, and refreshes it when it runs again. A cycle of any slot reads the
 * current set when it decides. Which candidates are approved is computed by
 * `tallyReview` whenever the set is read, so no writer and no reader copies
 * a verdict. A thesis instantiates an approved candidate by its approvedId
 * and keeps its instrument, direction and arm. How much, when and at what
 * level it enters are the decision's, made from the account and the prices.
 */
import { z } from 'zod';
import {
  DESK_LENSES,
  DeskVetoSchema,
  LensFindingSchema,
  SetCandidateSchema,
  tallyReview,
  type CandidateTally,
} from './strategyDeskTally.js';
import { type CycleSlot } from './dailyTradingCycleSlots.js';

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

export { REVIEWER_VERDICTS } from './dailyTradingCycleLenses.js';

/**
 * One day's set. Unknown fields pass through, so a set the operator writes
 * by hand needs only its day, a review label and its candidates.
 */
export const ApprovedSetSchema = z
  .object({
    tradingDay: z.string().regex(new RegExp(TRADING_DAY_PATTERN)),
    reviewRunId: z.string().min(1),
    candidates: z.array(SetCandidateSchema),
    lenses: z
      .object(
        Object.fromEntries(
          DESK_LENSES.map((lens) => [lens, z.array(LensFindingSchema).optional()]),
        ) as Record<
          (typeof DESK_LENSES)[number],
          z.ZodOptional<z.ZodArray<typeof LensFindingSchema>>
        >,
      )
      .passthrough()
      .default({}),
    vetoes: z.array(DeskVetoSchema).default([]),
  })
  .passthrough();
export type ApprovedSet = z.infer<typeof ApprovedSetSchema>;

/** The tally of every candidate the set holds. */
export function tallyApprovedSet(set: ApprovedSet): CandidateTally[] {
  return tallyReview({ candidates: set.candidates, lenses: set.lenses, vetoes: set.vetoes });
}

// ── The tally the cycle reads before it decides ───────────────────────────

/** The run deriver the cycle's tally-set task names, registered by the runtime. */
export const DESK_TALLY_DERIVER = 'trading.desk-tally' as const;

export interface DeskTallyValue {
  /** The approved candidates as the strategist proposed them, each with its tally. */
  approved: Array<Record<string, unknown>>;
  /** Every candidate the review turned down, with why. */
  turnedDown: Array<{ candidateId: string; why: string }>;
  /** What the set read gave: none, a set, or a set that does not parse. */
  setNote: string;
}

/**
 * The code tally over the set the cycle read, so decide reads which
 * candidates are approved instead of working it out. A missing or
 * unparsable set derives an empty list with a note; the decide contract
 * names the fault.
 */
export function deskTallyDerivation(
  args: unknown,
): { ok: true; value: DeskTallyValue } | { ok: false; message: string } {
  const raw = (args ?? {}) as Record<string, unknown>;
  let content: unknown = raw['set'];
  if (content === undefined || content === null) {
    return {
      ok: true,
      value: { approved: [], turnedDown: [], setNote: 'The day has no approved set.' },
    };
  }
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content) as unknown;
    } catch {
      return { ok: true, value: { approved: [], turnedDown: [], setNote: 'The set is not JSON.' } };
    }
  }
  const set = ApprovedSetSchema.safeParse(content);
  if (!set.success) {
    return {
      ok: true,
      value: { approved: [], turnedDown: [], setNote: `The set ${parseFault(set.error)}.` },
    };
  }
  const byId = new Map(set.data.candidates.map((c) => [c.candidateId, c]));
  const tallies = tallyApprovedSet(set.data);
  return {
    ok: true,
    value: {
      approved: tallies
        .filter((t) => t.approved)
        .map((t) => ({
          ...byId.get(t.candidateId),
          tally: { approvals: t.approvals, rejections: t.rejections, silent: t.silent },
        })),
      turnedDown: tallies
        .filter((t) => !t.approved)
        .map((t) => ({ candidateId: t.candidateId, why: t.why })),
      setNote: `The set written by ${set.data.reviewRunId} holds ${String(tallies.length)} candidates, ${String(tallies.filter((t) => t.approved).length)} approved.`,
    },
  };
}

// ── Contract fragments the cycle's tasks spread into their schemas ─────────

/** decide names its day, so the approved-set rule can find the set for it. */
export const DECIDE_IDENTITY_PROPERTIES = {
  tradingDay: {
    type: 'string',
    pattern: TRADING_DAY_PATTERN,
    description: 'This cycle’s trading day, copied from your input. It is pinned.',
  },
  approvedOpenedToday: {
    type: 'array',
    items: { type: 'string' },
    description:
      'The approvedIds earlier cycles of this trading day opened, copied from your input.',
  },
};

export const DECIDE_IDENTITY_PINS = [
  {
    bindingId: 'decide-trading-day-pin',
    from: 'resolve-theses',
    binding: 'value:$.tradingDay',
    target: '$.tradingDay.const',
  },
];

export const THESIS_APPROVAL_PROPERTIES = {
  approvedId: {
    type: 'string',
    pattern: APPROVED_ID_PATTERN,
    description: `The candidateId of the approved candidate in ${APPROVED_THESES_PATH_TEMPLATE} this thesis instantiates.`,
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
];

/** The cycle doc names the approval behind every thesis it opened. */
export const OPENED_APPROVALS_SCHEMA = {
  openedApprovals: {
    type: 'array',
    description:
      'One entry per thesis this cycle opened: its thesisId and the approvedId it instantiates. The set at that day keeps what each lens said on it.',
    items: {
      type: 'object',
      required: ['thesisId', 'approvedId'],
      additionalProperties: false,
      properties: {
        thesisId: { type: 'string' },
        approvedId: { type: 'string', pattern: APPROVED_ID_PATTERN },
      },
    },
  },
};

// A decide that failed opened nothing and named no set fault, so its pins
// hold the cycle doc to exactly that.
export const OPENED_APPROVALS_PINS = [
  {
    bindingId: 'opened-approvals-floor',
    from: 'decide',
    binding: 'count:$.theses',
    target: '$.cycleDoc.openedApprovals.minItems',
    whenUpstreamFailed: { value: 0 },
  },
  {
    bindingId: 'opened-approvals-ceiling',
    from: 'decide',
    binding: 'count:$.theses',
    target: '$.cycleDoc.openedApprovals.maxItems',
    whenUpstreamFailed: { value: 0 },
  },
  {
    bindingId: 'cycle-doc-set-fault-pin',
    from: 'decide',
    binding: 'value:$.approvedSetFault',
    target: '$.cycleDoc.approvedSetFault.const',
    whenUpstreamFailed: { value: null },
  },
];

const SET_FAULT_SCHEMA = { type: ['string', 'null'], maxLength: 4000 };

/** A bad set opens nothing but stops nothing either. decide names the fault and the cycle doc keeps it. */
export const DECIDE_SET_FAULT_PROPERTY = {
  approvedSetFault: {
    ...SET_FAULT_SCHEMA,
    description:
      'null when the approved set reads cleanly or does not exist. When the contract reports the set cannot be read, does not parse or comes from a refused writer, the fault sentence it quotes.',
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
 * one task of one completed run of another skill in this space, the run the
 * set names in reviewRunId. A conversation that drove a run is refused
 * whatever runs it drove, so an agent conversation cannot approve theses in
 * a run's name. A set any cycle run wrote is refused, so no cycle task can
 * approve its own theses.
 */
export function approvedSetWriterRefusal(
  writer: ApprovedSetWriter,
  reviewRunId: string,
  spaceId: string,
): string | null {
  if (writer.kind === 'operator') return null;
  const who = `session ${writer.sessionId ?? '(none)'}`;
  if (writer.drivenRuns.length > 0) {
    return `was written by ${who}, the conversation that drives run ${writer.drivenRuns.join(', ')}. A conversation is never a run's writer, so it cannot approve theses`;
  }
  if (writer.runs.length === 0) {
    return `was written by ${who}, which is the execution of no workflow run's task. Only the operator or a completed desk run may write it`;
  }
  if (writer.runs.length > 1) {
    return `was written by ${who}, which is tied to ${String(writer.runs.length)} runs (${writer.runs.map((r) => r.runId).join(', ')}). One desk run must write it`;
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
  if (reviewRunId !== run.runId) {
    return `was written by desk run ${run.runId}, but names review run ${reviewRunId}`;
  }
  return null;
}

const DecideApprovalViewSchema = z
  .object({
    tradingDay: z.string(),
    approvedSetFault: z.string().nullable(),
    approvedOpenedToday: z.array(z.string()).default([]),
    theses: z.array(
      z
        .object({
          approvedId: z.string(),
          hypothesisId: z.string(),
          instrument: z.string(),
          direction: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export interface ApprovedSetSource {
  /** The space the cycle runs in. A desk run of another space approves nothing here. */
  spaceId: string;
  /** Loads the set document by path, with the writer of its current version. */
  read: (path: string) => Promise<ApprovedSetRead>;
}

/**
 * A set that cannot be read, does not parse or comes from a refused writer
 * approves nothing, and the output must say so in `approvedSetFault`. The
 * fault gates new theses only: decide still submits, so this cycle's closes
 * and its record run.
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
      message: `${fault}. It approves nothing, so submit theses: [] and copy this fault into approvedSetFault. Closes and the record run as usual.`,
    });
  }
  if (declared === null || declared.trim() === '') {
    issues.push({
      path: ['approvedSetFault'],
      message: `${fault}. Set approvedSetFault to that sentence, so the cycle doc records the fault.`,
    });
  }
  return issues;
}

/**
 * Every thesis decide opens instantiates an approved candidate of the day's
 * set, once, with the candidate's instrument, direction and arm. Size,
 * timing, levels and horizon are the decision's own. The rule catches a
 * thesis that names no approved candidate, one the review turned down, and
 * one a cycle already opened today. It refuses nothing else.
 */
export async function approvedThesesIssues(
  output: unknown,
  source: ApprovedSetSource,
): Promise<ApprovedThesesIssue[]> {
  const view = DecideApprovalViewSchema.safeParse(output);
  if (!view.success) {
    return [{ path: [], message: 'The output does not carry its tradingDay and theses.' }];
  }
  const { tradingDay, theses, approvedSetFault, approvedOpenedToday } = view.data;
  const path = approvedThesesPath(tradingDay);
  const fault = (why: string) => faulted(path, why, theses, approvedSetFault);

  const doc = await source.read(path);
  if (doc.status === 'unreadable') return fault(`cannot be read (${doc.reason})`);
  if (theses.length === 0) {
    if (doc.status !== 'found') return [];
    const set = ApprovedSetSchema.safeParse(doc.content);
    if (!set.success) return approvedSetFault === null ? fault(parseFault(set.error)) : [];
    const refusal = approvedSetWriterRefusal(doc.writer, set.data.reviewRunId, source.spaceId);
    return refusal !== null && approvedSetFault === null ? fault(refusal) : [];
  }
  if (doc.status === 'missing') {
    return [
      {
        path: ['theses'],
        message: `No approved set exists at ${path}, so no thesis can open this cycle. Submit theses: [] and say so in decisionRationale.`,
      },
    ];
  }
  const set = ApprovedSetSchema.safeParse(doc.content);
  if (!set.success) return fault(parseFault(set.error));
  if (set.data.tradingDay !== tradingDay) {
    return fault(`names tradingDay ${set.data.tradingDay}, not ${tradingDay}`);
  }
  const refusal = approvedSetWriterRefusal(doc.writer, set.data.reviewRunId, source.spaceId);
  if (refusal) return fault(refusal);

  const tallies = new Map(tallyApprovedSet(set.data).map((t) => [t.candidateId, t]));
  const approvedIds = [...tallies.values()].filter((t) => t.approved).map((t) => t.candidateId);
  const opened = new Set(approvedOpenedToday);
  const cited = new Set<string>();
  const issues: ApprovedThesesIssue[] = [];
  theses.forEach((thesis, i) => {
    const at = (field: string, message: string) =>
      issues.push({ path: ['theses', i, field], message });
    const tally = tallies.get(thesis.approvedId);
    if (!tally) {
      at(
        'approvedId',
        `"${thesis.approvedId}" is no candidate of the set at ${path}. It approves: ${approvedIds.join(', ') || 'none'}.`,
      );
      return;
    }
    if (!tally.approved) {
      at('approvedId', `${tally.why} Drop this thesis.`);
      return;
    }
    if (cited.has(tally.candidateId) || opened.has(tally.candidateId)) {
      at(
        'approvedId',
        `"${tally.candidateId}" is already opened ${cited.has(tally.candidateId) ? 'by an earlier thesis of this output' : 'by an earlier cycle today'}. One approved candidate opens one thesis.`,
      );
    }
    cited.add(tally.candidateId);
    for (const field of ['instrument', 'direction', 'hypothesisId'] as const) {
      if (thesis[field] !== tally[field]) {
        at(
          field,
          `is ${thesis[field]}, but approved candidate ${tally.candidateId} is ${tally[field]}.`,
        );
      }
    }
  });
  return issues;
}

function parseFault(error: z.ZodError): string {
  const first = error.issues[0];
  return `does not parse (${first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'invalid'})`;
}
