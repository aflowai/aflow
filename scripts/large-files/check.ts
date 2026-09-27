import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { pathMatchesAllowlist, validateAllowlist } from './allowlist.js';
import { ALLOWLIST_PATH, BASELINE_PATH, THRESHOLDS } from './config.js';
import { buildScanReport } from './scan.js';
import type {
  CheckViolation,
  LargeFileAllowlist,
  LargeFileBaseline,
  ScannedFile,
} from './types.js';

function readJsonFile(repoRoot: string, relPath: string): unknown {
  const abs = join(repoRoot, relPath);
  const raw = readFileSync(abs, 'utf8');
  return JSON.parse(raw);
}

function growthAllowed(baselineLines: number, currentLines: number): boolean {
  const delta = currentLines - baselineLines;
  if (delta <= 0) {
    return true;
  }
  return delta <= THRESHOLDS.growthToleranceLines;
}

export function checkAgainstBaseline(
  repoRoot: string,
  options?: { baseline?: LargeFileBaseline; allowlist?: LargeFileAllowlist },
): { violations: CheckViolation[]; report: ReturnType<typeof buildScanReport> } {
  const report = buildScanReport(repoRoot);
  const baseline =
    options?.baseline ?? (readJsonFile(repoRoot, BASELINE_PATH) as LargeFileBaseline);
  const allowlist =
    options?.allowlist ?? (readJsonFile(repoRoot, ALLOWLIST_PATH) as LargeFileAllowlist);

  const violations: CheckViolation[] = [];

  for (const msg of validateAllowlist(allowlist)) {
    violations.push({
      kind: 'allowlist_invalid',
      path: ALLOWLIST_PATH,
      lines: 0,
      message: msg,
    });
  }

  const productionByPath = new Map<string, ScannedFile>();
  for (const file of report.files) {
    if (file.category === 'production') {
      productionByPath.set(file.path, file);
    }
  }

  for (const [path, entry] of Object.entries(baseline.files)) {
    const current = productionByPath.get(path);
    if (!current) {
      // File was removed or split below threshold — baseline entry can be dropped on next update.
      continue;
    }
    if (!growthAllowed(entry.lines, current.lines)) {
      violations.push({
        kind: 'baseline_growth',
        path,
        lines: current.lines,
        message:
          `production file grew beyond baseline tolerance (+${THRESHOLDS.growthToleranceLines} max): ` +
          `${entry.lines} → ${current.lines} (${path})`,
      });
    }
  }

  for (const file of report.overHardProduction) {
    if (baseline.files[file.path]) {
      continue;
    }
    const allowed = pathMatchesAllowlist(file.path, allowlist.entries);
    if (allowed) {
      // Omitted maxLines = exempt from the new-file hard gate; set maxLines only to cap growth.
      if (allowed.maxLines !== undefined && file.lines > allowed.maxLines) {
        violations.push({
          kind: 'new_over_budget',
          path: file.path,
          lines: file.lines,
          message: `allowlisted file exceeds maxLines (${allowed.maxLines}): ${file.lines} lines`,
        });
      }
      continue;
    }
    violations.push({
      kind: 'new_over_budget',
      path: file.path,
      lines: file.lines,
      message:
        `new production file exceeds ${THRESHOLDS.hardLines} LOC without baseline or allowlist: ` +
        `${file.lines} lines`,
    });
  }

  return { violations, report };
}

export function formatCheckResult(
  violations: CheckViolation[],
  report: ReturnType<typeof buildScanReport>,
): string {
  const lines: string[] = [formatScanReportHeader(report)];
  if (violations.length === 0) {
    lines.push('', '✓ large-file check passed');
    return lines.join('\n');
  }
  lines.push('', `✗ large-file check failed (${violations.length} violation(s)):`);
  for (const v of violations) {
    lines.push(`  - ${v.message}`);
  }
  return lines.join('\n');
}

function formatScanReportHeader(report: ReturnType<typeof buildScanReport>): string {
  return [
    `Large-file check`,
    `  production ≥${THRESHOLDS.warnLines} LOC (warn): ${report.warnings.length}`,
    `  production ≥${THRESHOLDS.hardLines} LOC (hard):  ${report.overHardProduction.length}`,
  ].join('\n');
}

export function buildBaselineFromScan(
  report: ReturnType<typeof buildScanReport>,
): LargeFileBaseline {
  const files: LargeFileBaseline['files'] = {};
  for (const file of report.overHardProduction) {
    files[file.path] = { lines: file.lines, category: file.category };
  }
  return {
    version: 1,
    capturedAt: report.scannedAt,
    thresholds: { ...THRESHOLDS },
    files,
  };
}
