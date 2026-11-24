import {
  rehearsalPlanStepsHash,
  type BundleRehearsalPlan,
  type BundleRehearsalResult,
  type StoreRehearsalLedger,
} from '@aflow/schemas';
import { BUNDLE_REHEARSAL_PLANS } from './plans.js';

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
 * Why a rehearsed bundle's published version does not count as done, or
 * null when it does. From the plan's `gateFromVersion` on, a version counts
 * only on a passing rehearsal of that version and content hash, run with the
 * plan's current steps. The gate reads the best record: any such pass
 * counts, whatever was recorded after it. Without one, the newest record of
 * the version and content explains the refusal, or else the newest record.
 * A failure names its step, a skip its reason, and a not_due record its
 * window, because none is a pass.
 */
export function rehearsalRefusal(
  plan: BundleRehearsalPlan,
  published: PublishedListing,
  records: readonly BundleRehearsalResult[] | undefined,
): string | null {
  if (published.version < plan.gateFromVersion) return null;
  const id = plan.catalogId;
  const v = String(published.version);
  const rehearse = `Run: ${REHEARSE_COMMAND} ${id} --space <the space that installed it>`;
  const history = records ?? [];
  if (history.some((r) => isCountedPass(r, plan, published))) return null;
  const newestFirst = [...history].reverse();
  const record = newestFirst.find((r) => samePublication(r, published)) ?? newestFirst[0];
  if (!record) return `${id} version ${v} has no rehearsal on record. ${rehearse}`;
  if (record.version !== published.version || record.contentHash !== published.contentHash) {
    return `${id} version ${v} has not been rehearsed: the last rehearsal on record is of version ${String(record.version)} (${record.contentHash.slice(0, 12)}). ${rehearse}`;
  }
  if (record.planStepsHash !== rehearsalPlanStepsHash(plan)) {
    return `${id} version ${v} has not been rehearsed with the plan's current steps: the plan has changed since the rehearsal on record ran. ${rehearse}`;
  }
  if (record.outcome === 'fail') {
    return `The rehearsal of ${id} version ${v} failed at ${record.failingStep?.stepId ?? 'an unnamed step'}: ${record.failingStep?.detail ?? ''}`;
  }
  if (record.outcome === 'skipped') {
    return `The rehearsal of ${id} version ${v} was skipped, and a skip is no pass: ${record.skipReason ?? ''} ${rehearse}`;
  }
  if (record.outcome === 'not_due') {
    const notDue = record.notDue;
    const next = notDue?.nextOpensAt
      ? ` The window next opens at ${notDue.nextOpensAt} exchange time.`
      : '';
    return `The rehearsal of ${id} version ${v} is not_due: the exchange window ${notDue?.window ?? 'unnamed'} was closed when step ${notDue?.stepId ?? 'unnamed'} was due.${next} ${record.window?.schedule ?? ''} ${rehearse}`;
  }
  return `${id} version ${v} has no pass on record that counts. ${rehearse}`;
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

/** Each rehearsed bundle whose published version the ledger does not let count as done. */
export function publicationRehearsalRefusals(
  published: Readonly<Record<string, PublishedListing>>,
  ledger: StoreRehearsalLedger,
): Array<{ catalogId: string; reason: string }> {
  return BUNDLE_REHEARSAL_PLANS.flatMap((plan) => {
    const listing = published[plan.catalogId];
    if (!listing) return [];
    const reason = rehearsalRefusal(plan, listing, ledger[plan.catalogId]);
    return reason === null ? [] : [{ catalogId: plan.catalogId, reason }];
  });
}
