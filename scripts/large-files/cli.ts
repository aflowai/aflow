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
      const report = buildScanReport(REPO_ROOT);
      console.log(formatScanReport(report));
      return;
    }
    case 'check': {
      const { violations, report } = checkAgainstBaseline(REPO_ROOT);
      console.log(formatCheckResult(violations, report));
      if (violations.length > 0) {
        process.exitCode = 1;
      }
      return;
    }
    case 'update-baseline': {
      const report = buildScanReport(REPO_ROOT);
      const baseline = buildBaselineFromScan(report);
      const outPath = join(REPO_ROOT, BASELINE_PATH);
      writeFileSync(outPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
      console.log(`Wrote ${BASELINE_PATH} (${Object.keys(baseline.files).length} files)`);
      console.log(formatScanReport(report));
      return;
    }
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Usage: scan | check | update-baseline');
      process.exitCode = 1;
  }
}

main();
