import {
  rehearsalPlanStepsHash,
  type BundleRehearsalPlan,
  type BundleRehearsalResult,
  type StoreRehearsalLedger,
} from '@aflow/schemas';
import { BUNDLE_REHEARSAL_PLANS } from './plans.js';
import { SMOKE_COMMAND } from './smokeBundle.js';

export const REHEARSE_COMMAND = 'yarn store:rehearse';

export interface PublishedListing {
  version: number;
  contentHash: string;
}

const samePublication = (record: BundleRehearsalResult, published: PublishedListing) =>
  record.version === published.version && record.contentHash === published.contentHash;

const isCountedPass = (
  record: BundleRehearsalResult,
  plan: BundleRehearsalPlan,
  published: PublishedListing,
) =>
  record.outcome === 'pass' &&
  samePublication(record, published) &&
  record.planStepsHash === rehearsalPlanStepsHash(plan);

/**
 * The records a publication reads for one bundle. `smokes` are its smoke
 * runs (`yarn store:smoke --record`, in storeSmokes.json). `rehearsals` are
 * its go-live rehearsals (`yarn store:rehearse`, in storeRehearsals.json).
 */
export interface RehearsalEvidence {
  smokes?: readonly BundleRehearsalResult[] | undefined;
  rehearsals?: readonly BundleRehearsalResult[] | undefined;
}

const sentence = (text: string) =>
  /[.!?]$/.test(text.trimEnd()) ? text.trimEnd() : `${text.trimEnd()}.`;

/**
 * Why one kind of record does not count for the published version. The
 * newest record of the version and content explains it, or else the newest
 * record. A failure names its step, a skip its reason, and a not_due record
 * its window, because none is a pass.
 */
function shortfall(
  plan: BundleRehearsalPlan,
  published: PublishedListing,
  records: readonly BundleRehearsalResult[],
): string {
  const newestFirst = [...records].reverse();
  const record = newestFirst.find((r) => samePublication(r, published)) ?? newestFirst[0];
  if (!record) return 'none is on record.';
  if (!samePublication(record, published)) {
    return `the last one on record is of version ${String(record.version)} (${record.contentHash.slice(0, 12)}).`;
  }
  if (record.planStepsHash !== rehearsalPlanStepsHash(plan)) {
    return "the one on record ran other steps than the plan's current steps.";
  }
  if (record.outcome === 'fail') {
    return `it failed at ${record.failingStep?.stepId ?? 'an unnamed step'}: ${record.failingStep?.detail ?? ''}`;
  }
  if (record.outcome === 'skipped') {
    return `it was skipped, and a skip is no pass: ${record.skipReason ?? ''}`;
  }
  if (record.outcome === 'not_due') {
    const notDue = record.notDue;
    const next = notDue?.nextOpensAt
      ? ` The window next opens at ${notDue.nextOpensAt} exchange time.`
      : '';
    const schedule = record.window?.schedule ? ` ${record.window.schedule}` : '';
    return `it is not_due: the exchange window ${notDue?.window ?? 'unnamed'} was closed when step ${notDue?.stepId ?? 'unnamed'} was due.${next}${schedule}`;
  }
  return 'no pass on record counts.';
}

/**
 * Why a rehearsed bundle's published version does not count as done, or
 * null when it does. From the plan's `gateFromVersion` on, a version counts
 * only on a pass of that version and content hash, run with the plan's
 * current steps. A smoke run's pass satisfies the gate. A go-live
 * rehearsal's pass satisfies it too, as the optional stronger check. The
 * gate reads the best record: any such pass counts, whatever was recorded
 * after it. A failure, a skip and a not_due record never count.
 */
export function rehearsalRefusal(
  plan: BundleRehearsalPlan,
  published: PublishedListing,
  evidence: RehearsalEvidence,
): string | null {
  if (published.version < plan.gateFromVersion) return null;
  const smokes = evidence.smokes ?? [];
  const rehearsals = evidence.rehearsals ?? [];
  if ([...smokes, ...rehearsals].some((r) => isCountedPass(r, plan, published))) return null;
  const id = plan.catalogId;
  return (
    `${id} version ${String(published.version)} has no passing smoke run or go-live rehearsal of its content and plan steps on record. ` +
    `Smoke run: ${sentence(shortfall(plan, published, smokes))} ` +
    `Go-live rehearsal: ${sentence(shortfall(plan, published, rehearsals))} ` +
    `Run: ${SMOKE_COMMAND} ${id} --record. A passing smoke run satisfies the gate. ` +
    `A passing go-live rehearsal (${REHEARSE_COMMAND} ${id} --space <the space that installed it>) satisfies it too, and it is optional.`
  );
}

/**
 * The bundle's records once `result` is recorded. A pass is never replaced
 * by a skip, a failure or a not_due record: every pass stays, except one the
 * new pass repeats for the same version, content and plan steps. Only the
 * newest record that is no pass is kept, because an older one explains
 * nothing a newer one does not.
 */
export function recordRehearsal(
  records: readonly BundleRehearsalResult[] | undefined,
  result: BundleRehearsalResult,
): BundleRehearsalResult[] {
  const repeats = (r: BundleRehearsalResult) =>
    r.version === result.version &&
    r.contentHash === result.contentHash &&
    r.planStepsHash === result.planStepsHash;
  const kept = (records ?? []).filter((r) =>
    r.outcome === 'pass' ? !(result.outcome === 'pass' && repeats(r)) : false,
  );
  return [...kept, result];
}

/**
 * Each rehearsed bundle whose published version neither the smoke ledger nor
 * the go-live rehearsal ledger lets count as done.
 */
export function publicationRehearsalRefusals(
  published: Readonly<Record<string, PublishedListing>>,
  ledgers: { smokes: StoreRehearsalLedger; rehearsals: StoreRehearsalLedger },
): Array<{ catalogId: string; reason: string }> {
  return BUNDLE_REHEARSAL_PLANS.flatMap((plan) => {
    const listing = published[plan.catalogId];
    if (!listing) return [];
    const reason = rehearsalRefusal(plan, listing, {
      smokes: ledgers.smokes[plan.catalogId],
      rehearsals: ledgers.rehearsals[plan.catalogId],
    });
    return reason === null ? [] : [{ catalogId: plan.catalogId, reason }];
  });
}
