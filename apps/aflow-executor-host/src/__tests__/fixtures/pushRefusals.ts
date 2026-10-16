/**
 * Every code the push gate refuses with. This file, unlike the tests that read
 * it, is compiled by `tsc`, and the census is a Record over both refusal
 * unions — so a code added to either receipt and left out here fails the
 * type-check.
 */
import type { CheckReceiptRefusal } from '../../checkReceipt.js';
import type { ScanReceiptRefusal } from '../../scanReceipt.js';

export type Refusal = ScanReceiptRefusal | CheckReceiptRefusal;

const CENSUS: Record<Refusal, true> = {
  no_base: true,
  no_receipt: true,
  not_issued_here: true,
  other_folder: true,
  other_range: true,
  base_conflicts: true,
  secret_found: true,
  unapproved: true,
  checks_undeclared: true,
  no_check_receipt: true,
  check_not_issued_here: true,
  check_other_folder: true,
  check_stale: true,
  check_other_commit: true,
  check_other_base: true,
  check_other_checks: true,
  check_other_posture: true,
  check_failed: true,
};

export const EVERY_REFUSAL = Object.keys(CENSUS) as readonly Refusal[];
