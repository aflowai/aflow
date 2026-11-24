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

/**
 * Why a rehearsed bundle's published version does not count as done, or
 * null when it does. From the plan's `gateFromVersion` on, a version counts
 * only on a passing rehearsal of that version and content hash, run with the
 * plan's current steps. A failure
 * names its step, and a skip names its reason, because neither is a pass.
 */
export function rehearsalRefusal(
  plan: BundleRehearsalPlan,
  published: PublishedListing,
  record: BundleRehearsalResult | undefined,
): string | null {
  if (published.version < plan.gateFromVersion) return null;
  const id = plan.catalogId;
  const v = String(published.version);
  const rehearse = `Run: ${REHEARSE_COMMAND} ${id} --space <the space that installed it>`;
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
  return null;
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
