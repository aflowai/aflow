import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BASELINE_PATH, THRESHOLDS, type BudgetBaseline, type BudgetReport } from './config.js';
import { buildScanReport } from './scan.js';

export interface BudgetViolation {
  key: string;
  baseline: number;
  current: number;
  allowed: number;
}

export function buildBaselineFromScan(report: BudgetReport): BudgetBaseline {
  const components: BudgetBaseline['components'] = {};
  for (const component of report.components) {
    components[component.key] = { tokens: component.tokens, group: component.group };
  }
  const totals: BudgetBaseline['totals'] = {};
  for (const [group, total] of Object.entries(report.totals)) {
    totals[group] = total.tokens;
  }
  return { version: 1, thresholds: THRESHOLDS, components, totals };
}

export function checkAgainstBaseline(repoRoot: string): {
  violations: BudgetViolation[];
  added: string[];
  removed: string[];
  report: BudgetReport;
  thresholdsDrifted: boolean;
} {
  const report = buildScanReport();
  const raw = readFileSync(join(repoRoot, BASELINE_PATH), 'utf8');
  const baseline = JSON.parse(raw) as BudgetBaseline;

  const violations: BudgetViolation[] = [];
  const added: string[] = [];
  const seen = new Set<string>();

  // A tolerance loosened in config while the baseline still records the old one
  // makes the audit trail lie, so the two are compared rather than assumed equal.
  const thresholdsDrifted = JSON.stringify(baseline.thresholds) !== JSON.stringify(THRESHOLDS);

  for (const component of report.components) {
    seen.add(component.key);
    const prior = baseline.components[component.key];
    if (!prior) {
      added.push(component.key);
      continue;
    }
    // Small components are exempt: rounding in a 40-token block is noise, and
    // failing on it trains people to regenerate the baseline without reading
    // it. Gated on the LARGER of the two, so a tiny row cannot grow many-fold
    // and stay under the exemption on its way up.
    if (Math.max(prior.tokens, component.tokens) < THRESHOLDS.minComponentTokens) continue;
    const allowed = Math.ceil(prior.tokens * (1 + THRESHOLDS.growthTolerancePct / 100));
    if (component.tokens > allowed) {
      violations.push({
        key: component.key,
        baseline: prior.tokens,
        current: component.tokens,
        allowed,
      });
    }
  }

  const removed = Object.keys(baseline.components).filter((key) => !seen.has(key));

  // Group totals are checked as well as rows. Fourteen rows each growing 9%
  // trips nothing individually while the turn grows by thousands of tokens —
  // death by a thousand cuts is precisely what a budget guard is for.
  for (const [group, total] of Object.entries(report.totals)) {
    const prior = baseline.totals[group];
    if (prior === undefined) continue;
    const allowed = Math.ceil(prior * (1 + THRESHOLDS.totalGrowthTolerancePct / 100));
    if (total.tokens > allowed) {
      violations.push({ key: `TOTAL:${group}`, baseline: prior, current: total.tokens, allowed });
    }
  }

  return { violations, added, removed, report, thresholdsDrifted };
}

export function formatCheckResult(result: {
  violations: BudgetViolation[];
  added: string[];
  removed: string[];
  report: BudgetReport;
  thresholdsDrifted: boolean;
}): string {
  const lines: string[] = ['Context budget check'];

  // A shrink is the goal of this work, so it never fails. A new or removed row
  // is reported loudly instead: renaming or splitting a component drops
  // enforcement on whatever it used to cover, and that must not pass silently.
  for (const key of result.added) lines.push(`  + new component (unbudgeted):     ${key}`);
  for (const key of result.removed) lines.push(`  - component gone from scan:       ${key}`);
  if (result.thresholdsDrifted) {
    lines.push('  ! baseline thresholds differ from config — run: yarn context:baseline');
  }
  for (const entry of result.report.unresolvedOps) {
    lines.push(`  ! declared operation does not resolve: ${entry}`);
  }

  if (result.violations.length === 0) {
    lines.push('');
    lines.push('✓ every component within baseline + tolerance');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`✗ ${String(result.violations.length)} component(s) over budget:`);
  for (const v of result.violations) {
    const growth =
      v.baseline > 0 ? `+${(((v.current - v.baseline) / v.baseline) * 100).toFixed(1)}%` : 'new';
    lines.push(
      `    ${v.key}: ${String(v.baseline)} → ${String(v.current)} tok (${growth}, allowed ${String(v.allowed)})`,
    );
  }
  lines.push('');
  lines.push('If the growth is intended, run: yarn context:baseline');
  return lines.join('\n');
}
