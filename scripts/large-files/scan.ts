import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { EXCLUDED_DIR_NAMES, EXCLUDED_PATH_FRAGMENTS, THRESHOLDS } from './config.js';
import { classifyFile } from './classify.js';
import type { ScanReport, ScannedFile } from './types.js';

function toPosixPath(path: string): string {
  return path.split('\\').join('/');
}

function isExcludedPath(repoRelativePath: string): boolean {
  const posix = `/${repoRelativePath}/`;
  return EXCLUDED_PATH_FRAGMENTS.some((fragment) => posix.includes(fragment));
}

/** Line count aligned with `wc -l` (no +1 for a trailing newline). */
export function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const lines = content.split('\n');
  if (lines.at(-1) === '') {
    return lines.length - 1;
  }
  return lines.length;
}

function walkTsFiles(rootDir: string, dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) {
        continue;
      }
      walkTsFiles(rootDir, fullPath, out);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) {
      continue;
    }
    const rel = toPosixPath(relative(rootDir, fullPath));
    if (isExcludedPath(rel)) {
      continue;
    }
    out.push(rel);
  }
}

export function scanRepository(repoRoot: string): ScannedFile[] {
  const paths: string[] = [];
  walkTsFiles(repoRoot, repoRoot, paths);
  paths.sort();

  const files: ScannedFile[] = [];
  for (const path of paths) {
    const abs = join(repoRoot, path);
    let content: string;
    try {
      statSync(abs);
      content = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const category = classifyFile(path, content);
    files.push({
      path,
      lines: countLines(content),
      category,
    });
  }
  return files;
}

export function buildScanReport(repoRoot: string): ScanReport {
  const files = scanRepository(repoRoot);
  const production = files.filter((f) => f.category === 'production');
  const warnings = production.filter((f) => f.lines >= THRESHOLDS.warnLines);
  const overHardProduction = production.filter((f) => f.lines >= THRESHOLDS.hardLines);

  return {
    scannedAt: new Date().toISOString(),
    files,
    warnings: [...warnings].sort((a, b) => b.lines - a.lines),
    overHardProduction: [...overHardProduction].sort((a, b) => b.lines - a.lines),
  };
}

export function formatScanReport(report: ScanReport): string {
  const lines: string[] = [
    `Large-file scan (${report.scannedAt})`,
    `  production ≥${THRESHOLDS.warnLines} LOC (warn): ${report.warnings.length}`,
    `  production ≥${THRESHOLDS.hardLines} LOC (hard):  ${report.overHardProduction.length}`,
    '',
    'Top production offenders:',
  ];

  const top = report.overHardProduction.slice(0, 25);
  if (top.length === 0) {
    lines.push('  (none)');
  } else {
    for (const file of top) {
      lines.push(`  ${String(file.lines).padStart(5)}  ${file.path}`);
    }
  }
  return lines.join('\n');
}
