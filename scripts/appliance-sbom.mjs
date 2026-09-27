#!/usr/bin/env node
/**
 * What the published appliance image contains, taken from the image itself.
 *
 * The filesystem check beside this one answers a yes/no question — is a
 * cloud-only workspace in there. This answers the open one: what IS in there,
 * as a list a reader can diff between releases and a scanner can take. A public
 * artifact that names its own contents is the difference between a supply-chain
 * question someone can answer and one they have to take on trust.
 *
 * Read by running Node inside the image rather than by resolving this
 * repository's lockfile: the lockfile describes what an install would produce,
 * and the only thing that settles what shipped is the thing that shipped.
 *
 *   node scripts/appliance-sbom.mjs --image <ref> [--out sbom.json] [--pruned <file>]
 *                                  [--compare other-sbom.json] [--no-telemetry]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
};

const image = valueOf('--image');
if (image === undefined) {
  console.error('[sbom] --image <ref> is required');
  process.exit(1);
}

/**
 * Walks `node_modules` inside the image and reports one entry per installed
 * package. A scoped package is two directory levels, and a nested copy is a
 * different version of the same name — both are entries, because both ship.
 */
const PROBE = `
const { readdirSync, readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const found = [];
function walk(dir, depth) {
  if (depth > 6 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (entry.name.startsWith('@')) { walk(full, depth); continue; }
    const manifest = join(full, 'package.json');
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        if (typeof pkg.name === 'string') {
          found.push({ name: pkg.name, version: String(pkg.version ?? '0.0.0'), license: typeof pkg.license === 'string' ? pkg.license : undefined });
        }
      } catch {}
    }
    walk(join(full, 'node_modules'), depth + 1);
  }
}
walk('node_modules', 0);
const workspaces = [];
for (const segment of ['apps', 'packages']) {
  if (!existsSync(segment)) continue;
  for (const entry of readdirSync(segment, { withFileTypes: true })) {
    if (entry.isDirectory()) workspaces.push(segment + '/' + entry.name);
  }
}
process.stdout.write(JSON.stringify({ found, workspaces }));
`;

function fromImage() {
  const raw = execFileSync('docker', ['run', '--rm', '--entrypoint', 'node', image, '-e', PROBE], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

let inventory;
try {
  inventory = fromImage();
} catch (error) {
  console.error(
    `[sbom] could not read ${image}: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

// One entry per name+version. A package installed twice at the same version is
// one component; two versions are two, because a reader chasing an advisory
// needs to know both are present.
const components = [
  ...new Map(
    inventory.found.map((pkg) => [
      `${pkg.name}@${pkg.version}`,
      {
        type: 'library',
        name: pkg.name,
        version: pkg.version,
        purl: `pkg:npm/${pkg.name.replace('@', '%40')}@${pkg.version}`,
        ...(pkg.license === undefined ? {} : { licenses: [{ license: { id: pkg.license } }] }),
      },
    ]),
  ).values(),
].sort((a, b) => (a.purl < b.purl ? -1 : 1));

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    component: { type: 'container', name: 'aflow-appliance', version: image },
    properties: inventory.workspaces.sort().map((workspace) => ({
      name: 'aflow:workspace',
      value: workspace,
    })),
  },
  components,
};

const out = valueOf('--out');
if (out !== undefined) {
  writeFileSync(out, `${JSON.stringify(sbom, null, 2)}\n`);
  console.log(`[sbom] ${String(components.length)} component(s) → ${out}`);
} else {
  process.stdout.write(`${JSON.stringify(sbom, null, 2)}\n`);
}

// ── What the inventory has to be able to say ────────────────────────────────

let failed = false;

// The check discriminates only if it also finds what must be there. An empty
// read reports a clean image.
if (components.length < 50) {
  console.error(`[sbom] only ${String(components.length)} component(s) — the image was not read`);
  failed = true;
}

// The closure of the local artifact against the closure of the full build. The
// release builds one image, so this is asked on demand rather than per release:
// what it proves is a property of the cut, which changes with the manifest and
// not with the version being cut.
const compareFile = valueOf('--compare');
if (compareFile !== undefined) {
  const other = JSON.parse(readFileSync(compareFile, 'utf-8'));
  const here = new Set(components.map((c) => c.name));
  const there = new Set(other.components.map((c) => c.name));
  const extra = [...here].filter((name) => !there.has(name)).sort();
  const withheld = [...there].filter((name) => !here.has(name)).sort();
  console.log(
    `[sbom] ${String(here.size)} package(s) here, ${String(there.size)} there; ` +
      `${String(withheld.length)} withheld, ${String(extra.length)} extra`,
  );
  if (extra.length > 0) {
    console.error(`[sbom] this image installs what the other does not: ${extra.join(', ')}`);
    failed = true;
  }
}

const prunedFile = valueOf('--pruned');
if (prunedFile !== undefined) {
  const { pruned } = JSON.parse(readFileSync(prunedFile, 'utf-8'));
  const installed = pruned.filter((name) => components.some((c) => c.name === name));
  console.log(
    `[sbom] the cut pruned ${String(pruned.length)} dependency(ies); ` +
      `${String(installed.length)} of them are in the image`,
  );
  if (installed.length > 0) {
    console.error(`[sbom] the image installs what the cut pruned: ${installed.join(', ')}`);
    failed = true;
  }
}

// Outbound closure (246d §6b): the local artifact carries no crash reporter and
// no analytics SDK. Asked of the image rather than of the configuration, because
// an unset `SENTRY_DSN` is a configuration — a later default, or an operator
// following a stale runbook, turns it back on, and the person who installed the
// appliance cannot audit an environment variable they never see. Absence is a
// property they can check; "off by default" is a promise.
//
// Names rather than a prefix scan: a scanner that greps for "analytics" flags a
// package that merely mentions it, and one that greps for a vendor misses the
// next vendor. This list is the closed set of reporters and analytics SDKs this
// repository has ever depended on, and an addition to it is a deliberate edit
// beside this comment.
const TELEMETRY_PACKAGES = [
  '@sentry/node',
  '@sentry/profiling-node',
  '@sentry/nextjs',
  '@sentry/browser',
  '@sentry/react',
  '@sentry/core',
  '@sentry/opentelemetry',
  'posthog-node',
  'posthog-js',
  'mixpanel',
  'mixpanel-browser',
  'amplitude-js',
  '@amplitude/analytics-node',
  '@amplitude/analytics-browser',
  'segment',
  '@segment/analytics-node',
  'analytics-node',
  '@datadog/browser-rum',
  'dd-trace',
  'bugsnag',
  '@bugsnag/js',
  'rollbar',
  'newrelic',
  'elastic-apm-node',
  'applicationinsights',
];

if (argv.includes('--no-telemetry')) {
  const present = TELEMETRY_PACKAGES.filter((name) =>
    components.some((c) => c.name === name),
  ).sort();
  console.log(
    `[sbom] checked ${String(TELEMETRY_PACKAGES.length)} reporter/analytics package name(s); ` +
      `${String(present.length)} present`,
  );
  if (present.length > 0) {
    console.error(
      `[sbom] the local artifact carries a crash reporter or analytics SDK: ${present.join(', ')}\n` +
        '[sbom] 246d §6b requires absence from the artifact, not an unset variable.',
    );
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
