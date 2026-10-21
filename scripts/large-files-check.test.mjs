/**
 * Contract: a large-file violation names the file it is about, so whoever
 * reads a failed check knows which file to split without scanning for it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkAgainstBaseline, formatCheckResult } from './large-files/check.ts';
import { THRESHOLDS } from './large-files/config.ts';

const EMPTY_BASELINE = {
  version: 1,
  capturedAt: '2026-01-01T00:00:00.000Z',
  thresholds: { ...THRESHOLDS },
  files: {},
};
const OVER_BUDGET_LINES = THRESHOLDS.hardLines + 10;

let repoRoot;

function writeProductionFile(relPath, lines) {
  const abs = path.join(repoRoot, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, 'export const x = 1;\n'.repeat(lines), 'utf8');
}

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'large-files-check-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('large-file check failure output', () => {
  it('names every new over-budget file by path', () => {
    writeProductionFile('packages/alpha/src/big.ts', OVER_BUDGET_LINES);
    writeProductionFile('apps/beta/src/huge.tsx', OVER_BUDGET_LINES);

    const { violations, report } = checkAgainstBaseline(repoRoot, {
      baseline: EMPTY_BASELINE,
      allowlist: { version: 1, entries: [] },
    });
    const output = formatCheckResult(violations, report);

    expect(violations.map((v) => v.kind)).toEqual(['new_over_budget', 'new_over_budget']);
    expect(output).toContain('✗ large-file check failed (2 violation(s))');
    expect(output).toContain(
      `new production file exceeds ${THRESHOLDS.hardLines} LOC without baseline or allowlist: ` +
        `${OVER_BUDGET_LINES} lines (packages/alpha/src/big.ts)`,
    );
    expect(output).toContain(
      `new production file exceeds ${THRESHOLDS.hardLines} LOC without baseline or allowlist: ` +
        `${OVER_BUDGET_LINES} lines (apps/beta/src/huge.tsx)`,
    );
  });

  it('names an allowlisted file that exceeds its maxLines', () => {
    writeProductionFile('packages/alpha/src/capped.ts', OVER_BUDGET_LINES);

    const { violations, report } = checkAgainstBaseline(repoRoot, {
      baseline: EMPTY_BASELINE,
      allowlist: {
        version: 1,
        entries: [
          {
            path: 'packages/alpha/src/capped.ts',
            owner: 'platform',
            reason: 'capped for the test',
            maxLines: THRESHOLDS.hardLines,
          },
        ],
      },
    });

    expect(formatCheckResult(violations, report)).toContain(
      `allowlisted file exceeds maxLines (${THRESHOLDS.hardLines}): ${OVER_BUDGET_LINES} lines ` +
        `(packages/alpha/src/capped.ts)`,
    );
  });
});
