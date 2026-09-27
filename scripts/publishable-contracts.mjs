#!/usr/bin/env node
/**
 * Which `@aflow/*` packages are published to npm, in the order they publish.
 *
 * The public product is the appliance, pulled as an image; these packages are a
 * different audience — code written *against* Aflow, by someone building a
 * connector, an applet or an embedding. So the set is deliberately the contract
 * surface rather than the runtime closure: publishing all nineteen packages the
 * hosted server consumes would buy an external author nothing and cost a
 * lockstep version bump on every release, forever.
 *
 * Order is dependency order, because `@aflow/schemas` declares `@aflow/lib` at
 * an exact version and npm cannot resolve it before it exists.
 *
 * The declared list and the manifests are two statements of the same fact, so
 * this file checks them against each other rather than trusting either: a
 * workspace that loses `private: true` becomes publishable silently, which is
 * how `@aflow/observability` came to be the only non-private workspace in the
 * repository without anyone deciding it should be.
 *
 *   node scripts/publishable-contracts.mjs          # print the publish order
 *   node scripts/publishable-contracts.mjs --check  # fail on drift
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Declared, in dependency order. Adding one is a deliberate edit here. */
export const CONTRACTS = ['@aflow/lib', '@aflow/schemas'];

/** Every workspace whose manifest would let npm publish it. */
export function publishableWorkspaces() {
  const found = [];
  for (const group of ['packages', 'apps']) {
    const base = join(REPO, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const manifest = join(base, name, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf-8'));
      if (typeof pkg.name !== 'string') continue;
      if (pkg.private === true) continue;
      found.push({ name: pkg.name, dir: `${group}/${name}`, version: pkg.version });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Drift in either direction, as sentences a reader can act on. */
export function drift() {
  const publishable = publishableWorkspaces();
  const names = new Set(publishable.map((w) => w.name));
  const problems = [];

  for (const declared of CONTRACTS) {
    if (!names.has(declared)) {
      problems.push(
        `${declared} is declared here but its manifest still says \`private: true\`, so a release would skip it.`,
      );
    }
  }
  for (const { name, dir } of publishable) {
    if (!CONTRACTS.includes(name)) {
      problems.push(
        `${name} (${dir}) is publishable but undeclared — either add \`private: true\` or add it to CONTRACTS.`,
      );
    }
  }
  // An exact dependency on an unpublished sibling cannot install.
  for (const declared of CONTRACTS) {
    const entry = publishable.find((w) => w.name === declared);
    if (entry === undefined) continue;
    const pkg = JSON.parse(readFileSync(join(REPO, entry.dir, 'package.json'), 'utf-8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!dep.startsWith('@aflow/')) continue;
      if (!CONTRACTS.includes(dep)) {
        problems.push(
          `${declared} depends on ${dep}, which is not published — the published package would not install.`,
        );
      } else if (CONTRACTS.indexOf(dep) > CONTRACTS.indexOf(declared)) {
        problems.push(
          `${declared} publishes before ${dep}, which it depends on. Reorder CONTRACTS.`,
        );
      }
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = drift();
  if (process.argv.includes('--check')) {
    if (problems.length > 0) {
      for (const problem of problems) console.error(`[contracts] ${problem}`);
      process.exit(1);
    }
    console.log(`[contracts] ${String(CONTRACTS.length)} declared, and the manifests agree`);
    process.exit(0);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[contracts] ${problem}`);
    process.exit(1);
  }
  for (const name of CONTRACTS) console.log(name);
}
