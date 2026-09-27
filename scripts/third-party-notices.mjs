#!/usr/bin/env node
/**
 * Third-party attribution, generated from the installed dependency tree.
 *
 * 246a §3 requires notices "generated from production dependencies", and
 * generated is the operative word: a hand-maintained list is wrong the first time
 * a dependency moves and nobody can tell by reading it.
 *
 * Read from `node_modules` rather than resolved from the lockfile, for the same
 * reason the appliance SBOM reads a built image: a lockfile describes what an
 * install would produce, and only the install settles what is actually there,
 * including the nested copy of a package that appears twice at different
 * versions.
 *
 *   node scripts/third-party-notices.mjs [--out THIRD-PARTY-NOTICES.md] [--check]
 *                                        [--sbom sbom.json] [--modules dir]
 *
 * `--modules` reads licences from another install: the core cut prepares its
 * tree without installing, so it names the repository's own `node_modules`
 * while the manifests it lists are the cut's.
 *
 * `--check` regenerates and compares, so CI fails on drift rather than shipping a
 * stale attribution file.
 *
 * Two sources, and they answer different questions. Without `--sbom` this reports
 * the **direct** production dependencies from the workspace manifests — the set a
 * reader can act on, and the one that changes when somebody adds a dependency.
 * With `--sbom`, it reports the components of a CycloneDX SBOM produced from a
 * built image, which is the full closure of what actually ships and therefore the
 * set attribution is legally about. The release path uses the second; a checkout
 * has no image, so it uses the first and says so in the output.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
};
const outPath = valueOf('--out') ?? 'THIRD-PARTY-NOTICES.md';
const checkOnly = argv.includes('--check');

const REPO = process.cwd();

/**
 * Which packages ship. `yarn workspaces focus --production` is what the image
 * install does, but running it here would mutate the checkout — so the set is
 * taken from the manifests instead: every workspace's `dependencies`, transitively
 * closed through what is installed.
 */
function productionRoots() {
  const roots = new Set();
  const manifests = execFileSync('git', ['ls-files', '*/package.json', 'package.json'], {
    cwd: REPO,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\n')
    .filter((line) => /^(?:apps|packages)\/[^/]+\/package\.json$|^package\.json$/.test(line));

  for (const manifest of manifests) {
    const pkg = JSON.parse(readFileSync(join(REPO, manifest), 'utf-8'));
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      // Workspace siblings are this project, not third parties.
      if (!name.startsWith('@aflow/')) roots.add(name);
    }
  }
  return roots;
}

/** One entry per installed package directory, scoped names included. */
function installedPackages(modulesDir) {
  const found = new Map();
  if (!existsSync(modulesDir)) return found;
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      const scopeDir = join(modulesDir, entry.name);
      for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
        if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue;
        record(found, `${entry.name}/${scoped.name}`, join(scopeDir, scoped.name));
      }
      continue;
    }
    record(found, entry.name, join(modulesDir, entry.name));
  }
  return found;
}

function record(found, name, dir) {
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) return;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return;
  }
  if (pkg.name === undefined) return;
  // A workspace symlinked into node_modules is this project.
  if (String(pkg.name).startsWith('@aflow/')) return;
  found.set(name, {
    name: String(pkg.name),
    version: String(pkg.version ?? 'unknown'),
    license: licenseOf(pkg),
    homepage: typeof pkg.homepage === 'string' ? pkg.homepage : undefined,
  });
}

/**
 * The declared licence, in the shapes npm actually carries: a string, the retired
 * object form, or the retired array. Unknown is reported as unknown rather than
 * guessed — an attribution file that invents a licence is worse than one that
 * says a dependency needs looking at.
 */
function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license !== null && typeof pkg.license === 'object' && 'type' in pkg.license) {
    return String(pkg.license.type);
  }
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses
      .map((l) => (typeof l === 'string' ? l : String(l?.type ?? '')))
      .filter(Boolean);
    if (types.length > 0) return types.join(' OR ');
  }
  return 'UNKNOWN';
}

/**
 * Licences that cannot appear in a distribution under AGPL-3.0-or-later without a
 * decision. Reported rather than enforced: the call is legal, and a script that
 * fails a release on a string match would be making it.
 */
const NEEDS_REVIEW = [
  /^(?:AGPL|GPL)-/i,
  /^SSPL/i,
  /^BUSL/i,
  /^CC-BY-NC/i,
  /^Commons-Clause/i,
  /UNKNOWN/,
];

/** Components of a CycloneDX SBOM, which is the closure of a built artifact. */
function fromSbom(path) {
  const doc = JSON.parse(readFileSync(path, 'utf-8'));
  return (doc.components ?? [])
    .map((c) => ({
      name: String(c.name),
      version: String(c.version ?? 'unknown'),
      license: sbomLicense(c),
      homepage: undefined,
    }))
    .filter((entry) => !entry.name.startsWith('@aflow/'))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function sbomLicense(component) {
  const declared = component.licenses ?? [];
  const names = declared
    .map((l) => l.license?.id ?? l.license?.name ?? l.expression)
    .filter((value) => typeof value === 'string' && value !== '');
  return names.length > 0 ? names.join(' OR ') : 'UNKNOWN';
}

const sbomPath = valueOf('--sbom');
const scope = sbomPath === undefined ? 'direct' : 'closure';
const shipped =
  sbomPath === undefined
    ? (() => {
        const roots = productionRoots();
        return [...installedPackages(valueOf('--modules') ?? join(REPO, 'node_modules')).values()]
          .filter((entry) => roots.has(entry.name))
          .sort((a, b) => a.name.localeCompare(b.name));
      })()
    : fromSbom(sbomPath);

const review = shipped.filter((entry) => NEEDS_REVIEW.some((rx) => rx.test(entry.license)));
const byLicense = new Map();
for (const entry of shipped) {
  byLicense.set(entry.license, [...(byLicense.get(entry.license) ?? []), entry]);
}

const lines = [
  '# Third-party notices',
  '',
  'Aflow depends on the open-source packages below, each under its own licence.',
  'Generated by `yarn third-party-notices` from the installed dependency tree — edit',
  'the dependencies rather than this file.',
  '',
  scope === 'direct'
    ? `${String(shipped.length)} direct production dependencies across ${String(byLicense.size)} declared licences. ` +
      'Direct dependencies only — the full closure of a release is generated from that ' +
      "release's SBOM, which is what attribution covers."
    : `${String(shipped.length)} packages in the built artifact across ${String(byLicense.size)} declared licences, ` +
      'read from its CycloneDX SBOM.',
  '',
];

if (review.length > 0) {
  lines.push(
    '> **Needs a licensing decision.** These declare a licence that does not sit',
    '> straightforwardly inside an AGPL distribution, or declare none at all. Listed',
    '> rather than judged — the call is legal, not mechanical.',
    '>',
    ...review.map((entry) => `> - \`${entry.name}@${entry.version}\` — ${entry.license}`),
    '',
  );
}

for (const [license, entries] of [...byLicense].sort((a, b) => b[1].length - a[1].length)) {
  lines.push(`## ${license} — ${String(entries.length)}`, '');
  for (const entry of entries) {
    lines.push(
      `- \`${entry.name}@${entry.version}\`${entry.homepage ? ` — ${entry.homepage}` : ''}`,
    );
  }
  lines.push('');
}

const rendered = lines.join('\n').replace(/\n{3,}/g, '\n\n');

if (checkOnly) {
  const current = existsSync(join(REPO, outPath)) ? readFileSync(join(REPO, outPath), 'utf-8') : '';
  if (current !== rendered) {
    console.error(
      `[notices] ${outPath} is out of date — run \`yarn third-party-notices\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(
    `[notices] ${outPath} matches the installed tree (${String(shipped.length)} packages)`,
  );
  process.exit(0);
}

writeFileSync(join(REPO, outPath), rendered);
console.log(
  `[notices] wrote ${outPath}: ${String(shipped.length)} packages, ${String(byLicense.size)} licences` +
    (review.length > 0 ? `, ${String(review.length)} needing a decision` : ''),
);
