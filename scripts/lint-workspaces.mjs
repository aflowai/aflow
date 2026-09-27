#!/usr/bin/env node
/**
 * Runs ESLint once per workspace instead of once over the monorepo.
 *
 * The type-aware rules build a TypeScript program covering everything reachable
 * from the files being linted. A single pass over all workspaces unions those
 * graphs into one process, which had grown past an 8GB heap — near the ceiling
 * V8 spends most of its time in GC, so the same commit could take 5 minutes or
 * 35 depending on how much memory the runner happened to have. Per-workspace
 * processes keep each graph small and hand the memory back on exit.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Everything outside apps/* and packages/* — root config plus the dev scripts. */
const NON_WORKSPACE_TARGETS = ['scripts', 'eslint-rules', 'eslint.config.mjs', 'vitest.config.ts'];

const LINTABLE = /\.(ts|tsx|mjs|cjs|js|jsx)$/;
// `tmp` is gitignored scratch: throwaway probes, never repo content. A lintable
// file there is not source going unlinted, and refusing to run over one turns
// any measurement script left lying around into a broken `yarn typecheck`.
const NOT_SOURCE = new Set(['node_modules', 'dist', 'coverage', 'apps', 'packages', 'tmp']);

/**
 * Splitting `eslint .` into explicit targets means a new top-level directory
 * would silently go unlinted, so refuse to run rather than report a false green.
 */
function assertTargetsCoverRepo() {
  const uncovered = [];
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    const name = entry.name;
    if (name.startsWith('.') || NOT_SOURCE.has(name)) continue;
    if (NON_WORKSPACE_TARGETS.includes(name)) continue;
    if (entry.isDirectory()) {
      if (containsLintableFile(join(ROOT, name))) uncovered.push(`${name}/`);
    } else if (LINTABLE.test(name)) {
      uncovered.push(name);
    }
  }
  if (uncovered.length > 0) {
    throw new Error(
      `Lintable paths outside every target: ${uncovered.join(', ')}. ` +
        `Add them to NON_WORKSPACE_TARGETS in scripts/lint-workspaces.mjs.`,
    );
  }
}

function containsLintableFile(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || NOT_SOURCE.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (containsLintableFile(full)) return true;
    } else if (LINTABLE.test(entry.name)) {
      return true;
    }
  }
  return false;
}

function workspaceTargets() {
  const targets = [];
  for (const segment of ['packages', 'apps']) {
    const base = join(ROOT, segment);
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(base, entry.name, 'package.json'))) {
        targets.push(`${segment}/${entry.name}`);
      }
    }
  }
  return targets.sort();
}

function lint(target) {
  return new Promise((resolve) => {
    const child = spawn(
      'node',
      [join(ROOT, 'node_modules/eslint/bin/eslint.js'), target, '--no-error-on-unmatched-pattern'],
      {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      resolve({ target, code: code ?? 1, stdout, stderr });
    });
  });
}

async function main() {
  assertTargetsCoverRepo();
  // The coverage assertion is milliseconds; the full lint is minutes. Cheap
  // repo-shape gates ride the most-traveled command (`yarn typecheck`) so they
  // fire in the inner loop instead of first appearing in CI.
  if (process.argv.includes('--assert-only')) return;
  const targets = [...workspaceTargets(), ...NON_WORKSPACE_TARGETS];
  // Each child peaks around 2GB, so keep the fleet inside a 16GB runner.
  const concurrency =
    Number(process.env['LINT_CONCURRENCY']) || Math.min(availableParallelism(), 4);

  const queue = [...targets];
  const failures = [];
  let completed = 0;

  async function worker() {
    for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
      const result = await lint(target);
      completed += 1;
      const status = result.code === 0 ? 'ok' : 'FAIL';
      process.stdout.write(`[${completed}/${targets.length}] ${status}  ${result.target}\n`);
      if (result.stdout.trim()) process.stdout.write(`${result.stdout.trimEnd()}\n`);
      if (result.stderr.trim()) process.stderr.write(`${result.stderr.trimEnd()}\n`);
      if (result.code !== 0) failures.push(result.target);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

  if (failures.length > 0) {
    process.stderr.write(
      `\nESLint failed in ${failures.length} target(s): ${failures.join(', ')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`\nESLint clean across ${targets.length} targets.\n`);
}

await main();
