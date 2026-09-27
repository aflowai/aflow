import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ALLOWLIST_PATH,
  BASELINE_PATH,
  THRESHOLDS,
  buildBaselineFromScan,
  buildScanReport,
  checkAgainstBaseline,
  classifyFile,
  countLines,
  pathMatchesAllowlist,
} from '../../../../scripts/large-files/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../..');

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-large-files-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(
    join(dir, ALLOWLIST_PATH),
    `${readFileSync(join(REPO_ROOT, ALLOWLIST_PATH), 'utf8')}`,
  );
  return dir;
}

describe('large-file guardrails', () => {
  it('countLines matches wc -l (no trailing-newline inflation)', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('one')).toBe(1);
    expect(countLines('one\n')).toBe(1);
    expect(countLines('one\ntwo\n')).toBe(2);
    expect(countLines('one\ntwo')).toBe(2);
  });

  it('allowlisted file without maxLines is exempt from the hard gate', () => {
    const dir = makeTempRepo();
    try {
      writeFileSync(
        join(dir, BASELINE_PATH),
        `${JSON.stringify(
          {
            version: 1,
            capturedAt: new Date().toISOString(),
            thresholds: { ...THRESHOLDS },
            files: {},
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        join(dir, ALLOWLIST_PATH),
        `${JSON.stringify({
          version: 1,
          entries: [
            {
              path: 'apps/demo/src/LegacyGod.ts',
              reason: 'legacy module pending split',
              owner: 'platform',
            },
          ],
        })}\n`,
      );

      mkdirSync(join(dir, 'apps/demo/src'), { recursive: true });
      const big = `${'// line\n'.repeat(THRESHOLDS.hardLines + 20)}export {};\n`;
      writeFileSync(join(dir, 'apps/demo/src/LegacyGod.ts'), big, 'utf8');

      const { violations } = checkAgainstBaseline(dir);
      expect(violations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allowlisted file with maxLines still enforces that ceiling', () => {
    const dir = makeTempRepo();
    try {
      writeFileSync(
        join(dir, BASELINE_PATH),
        `${JSON.stringify(
          {
            version: 1,
            capturedAt: new Date().toISOString(),
            thresholds: { ...THRESHOLDS },
            files: {},
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        join(dir, ALLOWLIST_PATH),
        `${JSON.stringify({
          version: 1,
          entries: [
            {
              path: 'apps/demo/src/Capped.ts',
              reason: 'temporary cap',
              owner: 'platform',
              maxLines: THRESHOLDS.hardLines,
            },
          ],
        })}\n`,
      );

      mkdirSync(join(dir, 'apps/demo/src'), { recursive: true });
      const big = `${'// line\n'.repeat(THRESHOLDS.hardLines + 1)}export {};\n`;
      writeFileSync(join(dir, 'apps/demo/src/Capped.ts'), big, 'utf8');

      const { violations } = checkAgainstBaseline(dir);
      expect(violations.some((v) => v.kind === 'new_over_budget')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips nested .claude worktree directories', () => {
    const dir = makeTempRepo();
    try {
      const nested = join(dir, '.claude/worktrees/plan-153/apps/demo/src');
      mkdirSync(nested, { recursive: true });
      const big = `${'// line\n'.repeat(THRESHOLDS.hardLines + 50)}export {};\n`;
      writeFileSync(join(nested, 'NestedCopy.ts'), big, 'utf8');

      writeFileSync(
        join(dir, BASELINE_PATH),
        `${JSON.stringify(
          {
            version: 1,
            capturedAt: new Date().toISOString(),
            thresholds: { ...THRESHOLDS },
            files: {},
          },
          null,
          2,
        )}\n`,
      );

      const { violations } = checkAgainstBaseline(dir);
      expect(violations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('matches allowlist glob patterns', () => {
    const entries = [
      {
        path: 'packages/generated/**/*.ts',
        reason: 'generated',
        owner: 'platform',
      },
    ];
    expect(pathMatchesAllowlist('packages/generated/foo/bar.ts', entries)?.path).toBe(
      'packages/generated/**/*.ts',
    );
    expect(pathMatchesAllowlist('packages/other/bar.ts', entries)).toBeUndefined();
  });

  it('classifies test and production paths', () => {
    expect(classifyFile('apps/web/src/foo.test.ts', '')).toBe('test');
    expect(classifyFile('apps/web/src/page.tsx', 'export {}')).toBe('production');
    expect(classifyFile('packages/db/src/seeds/foo.ts', '')).toBe('seed');
  });

  it('passes check against the committed baseline on the real repo', () => {
    const baseline = JSON.parse(readFileSync(join(REPO_ROOT, BASELINE_PATH), 'utf8')) as ReturnType<
      typeof buildBaselineFromScan
    >;
    const allowlist = JSON.parse(readFileSync(join(REPO_ROOT, ALLOWLIST_PATH), 'utf8'));
    const { violations } = checkAgainstBaseline(REPO_ROOT, { baseline, allowlist });
    expect(violations).toEqual([]);
  });

  it('fails when a new production file exceeds the hard gate', () => {
    const dir = makeTempRepo();
    try {
      writeFileSync(
        join(dir, BASELINE_PATH),
        `${JSON.stringify(
          {
            version: 1,
            capturedAt: new Date().toISOString(),
            thresholds: { ...THRESHOLDS },
            files: {},
          },
          null,
          2,
        )}\n`,
      );

      mkdirSync(join(dir, 'apps/demo/src'), { recursive: true });
      const big = `${'// line\n'.repeat(THRESHOLDS.hardLines + 1)}export {};\n`;
      writeFileSync(join(dir, 'apps/demo/src/GodModule.ts'), big, 'utf8');

      const { violations } = checkAgainstBaseline(dir);
      expect(violations.some((v) => v.kind === 'new_over_budget')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when a baseline production file grows beyond tolerance', () => {
    const dir = makeTempRepo();
    try {
      mkdirSync(join(dir, 'apps/demo/src'), { recursive: true });
      const path = 'apps/demo/src/Stable.ts';
      const initial = `${'// line\n'.repeat(THRESHOLDS.hardLines)}export {};\n`;
      writeFileSync(join(dir, path), initial, 'utf8');

      const report = buildScanReport(dir);
      const baseline = buildBaselineFromScan(report);
      writeFileSync(join(dir, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`);

      const grown = `${'// line\n'.repeat(THRESHOLDS.hardLines + THRESHOLDS.growthToleranceLines + 1)}export {};\n`;
      writeFileSync(join(dir, path), grown, 'utf8');

      const { violations } = checkAgainstBaseline(dir);
      expect(violations.some((v) => v.kind === 'baseline_growth')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
