#!/usr/bin/env node
/**
 * A migration a branch adds must take a number nobody else holds.
 *
 * Each branch numbers its migration "highest on main, plus one" when it is
 * written, so two branches open at once take the same number, and the second
 * to merge finds out as a conflict on a file whose content is not in conflict
 * at all. This says so on the pull request instead, while renumbering is one
 * file and an index line.
 *
 * Two modes, both seconds:
 * - In CI on a pull request (GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER
 *   set): the pull request's files, main's migrations and every other open pull
 *   request's files come from the GitHub API, so a shallow checkout suffices.
 *   A number another open pull request also adds fails only the one opened
 *   later, so two pull requests never block each other.
 * - Anywhere else: git, against `--base` (default `origin/main`), offline.
 */
import { spawnSync } from 'node:child_process';

const MIGRATIONS_DIR = 'packages/database/src/tenant/migrations/';
const MIGRATION_FILE = /^packages\/database\/src\/tenant\/migrations\/migration(\d+)\.ts$/;

function numberOf(path) {
  const match = MIGRATION_FILE.exec(path);
  return match === null ? undefined : Number(match[1]);
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    console.error(`check-migration-numbers: git ${args.join(' ')} failed:\n${result.stderr}`);
    process.exit(2);
  }
  return result.stdout.split('\n').filter((line) => line !== '');
}

async function api(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path}: ${String(response.status)} ${await response.text()}`);
  }
  return await response.json();
}

/** Every file a pull request adds, across pages. */
async function addedByPullRequest(repo, number) {
  const added = [];
  for (let page = 1; ; page += 1) {
    const files = await api(
      `/repos/${repo}/pulls/${String(number)}/files?per_page=100&page=${String(page)}`,
    );
    for (const file of files) if (file.status === 'added') added.push(file.filename);
    if (files.length < 100) return added;
  }
}

async function fromGitHub() {
  const repo = process.env.GITHUB_REPOSITORY;
  const self = Number(process.env.PR_NUMBER);
  const base = process.env.BASE_REF ?? 'main';
  const added = (await addedByPullRequest(repo, self)).map(numberOf).filter((n) => n !== undefined);
  if (added.length === 0) return { added, onBase: [], openElsewhere: new Map(), base };

  const listing = await api(`/repos/${repo}/contents/${MIGRATIONS_DIR.slice(0, -1)}?ref=${base}`);
  const onBase = listing.map((entry) => numberOf(entry.path)).filter((n) => n !== undefined);

  const openElsewhere = new Map();
  const open = await api(`/repos/${repo}/pulls?state=open&base=${base}&per_page=100`);
  for (const pull of open) {
    if (pull.number === self) continue;
    for (const path of await addedByPullRequest(repo, pull.number)) {
      const n = numberOf(path);
      if (n !== undefined) openElsewhere.set(n, [...(openElsewhere.get(n) ?? []), pull.number]);
    }
  }
  return { added, onBase, openElsewhere, base, self };
}

function fromGit(base) {
  const added = git([
    'diff',
    '--name-only',
    '--diff-filter=A',
    `${base}...HEAD`,
    '--',
    MIGRATIONS_DIR,
  ])
    .map(numberOf)
    .filter((n) => n !== undefined);
  const onBase = git(['ls-tree', '--name-only', base, MIGRATIONS_DIR])
    .map(numberOf)
    .filter((n) => n !== undefined);
  return { added, onBase, openElsewhere: new Map(), base };
}

const baseArg = process.argv.indexOf('--base');
const inPullRequest =
  process.env.GITHUB_TOKEN !== undefined &&
  process.env.GITHUB_REPOSITORY !== undefined &&
  process.env.PR_NUMBER !== undefined &&
  process.env.PR_NUMBER !== '';
const { added, onBase, openElsewhere, base, self } = inPullRequest
  ? await fromGitHub()
  : fromGit(
      baseArg === -1 ? (process.env.AFLOW_CHECK_BASE ?? 'origin/main') : process.argv[baseArg + 1],
    );

const highest = Math.max(0, ...onBase);
const problems = [];
for (const n of added) {
  if (n <= highest) {
    problems.push(
      `migration${String(n)}.ts: ${base} already reaches migration${String(highest)}.ts, ` +
        `so this one must be at least ${String(highest + 1)}.`,
    );
  }
  const earlier = (openElsewhere.get(n) ?? []).filter((other) => other < self);
  if (earlier.length > 0) {
    problems.push(
      `migration${String(n)}.ts: open pull request ${earlier.map((p) => `#${String(p)}`).join(', ')} ` +
        `adds the same number and was opened first; renumber this one.`,
    );
  }
}

if (problems.length > 0) {
  console.error('Migration numbers collide:');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(`Renumber the file, its export and its entry in ${MIGRATIONS_DIR}index.ts.`);
  process.exit(1);
}
console.log(
  added.length === 0
    ? 'No migration added.'
    : `Migration ${added.map((n) => `migration${String(n)}.ts`).join(', ')} is free on ${base}` +
        (inPullRequest ? ' and in every other open pull request.' : '.'),
);
