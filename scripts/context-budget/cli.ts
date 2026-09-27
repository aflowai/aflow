#!/usr/bin/env npx tsx
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASELINE_PATH } from './config.js';
import { buildBaselineFromScan, checkAgainstBaseline, formatCheckResult } from './check.js';
import { buildScanReport, formatScanReport } from './scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');

function main(): void {
  const command = process.argv[2] ?? 'check';

  switch (command) {
    case 'scan': {
      console.log(formatScanReport(buildScanReport()));
      return;
    }
    case 'check': {
      const result = checkAgainstBaseline(REPO_ROOT);
      console.log(formatCheckResult(result));
      // Drift fails as well as warns: loosening the tolerance in config while
      // the baseline still records the old one weakens the gate immediately and
      // leaves the audit trail claiming otherwise.
      if (result.violations.length > 0 || result.thresholdsDrifted) process.exitCode = 1;
      return;
    }
    case 'update-baseline': {
      const report = buildScanReport();
      const outPath = join(REPO_ROOT, BASELINE_PATH);
      writeFileSync(outPath, `${JSON.stringify(buildBaselineFromScan(report), null, 2)}\n`, 'utf8');
      console.log(`Wrote ${BASELINE_PATH} (${String(report.components.length)} components)`);
      console.log(formatScanReport(report));
      return;
    }
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Usage: context-budget <scan|check|update-baseline>');
      process.exitCode = 1;
  }
}

main();
