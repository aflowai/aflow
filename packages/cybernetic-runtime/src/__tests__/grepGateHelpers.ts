/**
 * Pure Node repo scanners for naming / ledger grep gates (Plans 104a §6, 104c).
 *
 * Avoids `@vscode/ripgrep` — its install hook builds native binaries and fails
 * on some CI runners during `yarn install`.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ScanTreeOptions {
  repoRoot: string;
  /** Top-level dirs under repo root (e.g. `packages`, `apps`). */
  roots: readonly string[];
  /** Include file if relative path matches (normalized with `/`). */
  includeFile: (relPath: string) => boolean;
  /** Optional extra exclude in addition to skipped directories. */
  excludeFile?: (relPath: string) => boolean;
}

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.git']);

function* walkFiles(absDir: string, repoRoot: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const abs = path.join(absDir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      yield* walkFiles(abs, repoRoot);
    } else if (ent.isFile()) {
      yield path.relative(repoRoot, abs).replace(/\\/g, '/');
    }
  }
}

function* iterRelativeFiles(repoRoot: string, roots: readonly string[]): Generator<string> {
  for (const root of roots) {
    const absRoot = path.join(repoRoot, root);
    if (!fs.existsSync(absRoot)) continue;
    const st = fs.statSync(absRoot);
    if (st.isFile()) {
      yield path.relative(repoRoot, absRoot).replace(/\\/g, '/');
      continue;
    }
    yield* walkFiles(absRoot, repoRoot);
  }
}

/** Fail if any scanned file's content matches (regex per line, rg-like). */
export function assertPatternAbsentInTree(pattern: RegExp, opts: ScanTreeOptions): void {
  const exclude = opts.excludeFile ?? (() => false);

  const violations: string[] = [];
  for (const rel of iterRelativeFiles(opts.repoRoot, opts.roots)) {
    if (!opts.includeFile(rel) || exclude(rel)) continue;
    const abs = path.join(opts.repoRoot, rel);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        violations.push(`${rel}: ${line.trim().slice(0, 200)}`);
        break;
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `grep gate failed (matches found):\n${violations.slice(0, 40).join('\n')}${violations.length > 40 ? `\n… (${String(violations.length)} total)` : ''}`,
    );
  }
}

/** Literal substring search (rg `-F`). */
export function assertLiteralAbsentInTree(literal: string, opts: ScanTreeOptions): void {
  const exclude = opts.excludeFile ?? (() => false);
  const violations: string[] = [];

  for (const rel of iterRelativeFiles(opts.repoRoot, opts.roots)) {
    if (!opts.includeFile(rel) || exclude(rel)) continue;
    const abs = path.join(opts.repoRoot, rel);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (content.includes(literal)) {
      violations.push(rel);
      if (violations.length >= 40) break;
    }
  }

  if (violations.length > 0) {
    throw new Error(`grep gate failed (literal matches): ${violations.join(', ')}`);
  }
}

export function assertPatternAbsentInFiles(
  pattern: RegExp,
  repoRoot: string,
  relativeFiles: readonly string[],
): void {
  const violations: string[] = [];
  for (const rel of relativeFiles) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const content = fs.readFileSync(abs, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        violations.push(`${rel}: ${line.trim().slice(0, 200)}`);
        break;
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`grep gate failed:\n${violations.join('\n')}`);
  }
}

export function extMatches(rel: string, extensions: readonly string[]): boolean {
  const ext = path.extname(rel);
  return extensions.includes(ext);
}
