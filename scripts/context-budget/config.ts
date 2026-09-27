export const THRESHOLDS = {
  /**
   * How far a component may grow past its baseline before `check` fails.
   *
   * Loose on purpose. A tolerance tight enough to trip on every legitimate
   * operation addition gets ignored, and an ignored check guards nothing —
   * this exists to catch unintended growth, not to freeze the surface.
   */
  growthTolerancePct: 10,
  /**
   * Tighter than the per-row bound, because the aggregate is the number that is
   * actually paid. Rows get slack for legitimate local change; letting every row
   * take its full 10% would pass thousands of tokens of drift with no violation.
   */
  totalGrowthTolerancePct: 4,
  /**
   * Components below this are not worth failing a build over; a rounding
   * difference in a 40-token block is noise, not drift.
   */
  minComponentTokens: 50,
} as const;

export const BASELINE_PATH = 'scripts/context-budget-baseline.json';

/**
 * The space name the prompt is assembled against when scanning.
 *
 * Fixed rather than sampled: the assembled prompt interpolates the space name,
 * so a varying name would move the baseline by a few tokens for no reason.
 */
export const SCAN_SPACE_NAME = 'baseline-space';

export interface BudgetComponent {
  /** Stable key — the baseline is keyed on this, so renaming resets history. */
  key: string;
  group: 'tools' | 'helmsmanPrompt' | 'runnerPrompt' | 'spaceContextGuidance' | 'worstCase';
  tokens: number;
  chars: number;
}

export interface BudgetReport {
  components: BudgetComponent[];
  totals: Record<string, { tokens: number; chars: number }>;
  /** Declared operation ids that no longer resolve — a config bug, always reported. */
  unresolvedOps: string[];
}

export interface BudgetBaseline {
  version: 1;
  thresholds: typeof THRESHOLDS;
  components: Record<string, { tokens: number; group: string }>;
  totals: Record<string, number>;
}
