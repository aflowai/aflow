/**
 * The forge seam's guard (Plan 340 D3): Local Publish, the Local PR Shepherd
 * and the pull request event source speak the forge vocabulary, and a
 * provider's own names stay inside that provider.
 *
 * The case that must fail if the seam leaks: a provider's field name — such
 * as `mergeable_state` — written in a skill or poller file. The names are
 * read from the provider, never restated here: its declared field names,
 * the endpoint ids of its API definition, its response transforms, and every
 * name its modules export.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GITHUB_API_ID,
  GITHUB_FORGE_FIELD_NAMES,
  JOB_LOG_TAIL_PRESET,
  SHEPHERD_RESPONSE_PRESETS,
} from '@aflow/schemas';
import { GITHUB_CONNECTOR } from '../connectorCatalog/github.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** GitHub's provider, in each layer it answers the vocabulary from. */
const GITHUB_PROVIDER = [
  'packages/schemas/src/forge/github.ts',
  'packages/platform-artifacts/src/forge/github/',
  'packages/platform-artifacts/src/connectorCatalog/github.ts',
  'apps/aflow-executor-api/src/handlers/api/forge/github/',
  'apps/aflow-orchestrator/src/services/forge/github/',
];

/**
 * The files D3 holds to the vocabulary: the skills' and the poller's, by
 * family, so a sibling added later is held as well.
 */
const HELD = [
  { dir: 'packages/platform-artifacts/src/skillCatalog', name: /^localPrShepherd\w*\.ts$/ },
  { dir: 'packages/platform-artifacts/src/skillCatalog', name: /^publishLocalChanges\w*\.ts$/ },
  { dir: 'apps/aflow-orchestrator/src/services/pullRequestEvents', name: /\.ts$/ },
  { dir: 'apps/aflow-orchestrator/src', name: /^index\.ts$/ },
];

function isSource(name: string): boolean {
  return name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(name);
}

function filesUnder(path: string): string[] {
  const absolute = join(REPO_ROOT, path);
  if (!path.endsWith('/')) return [absolute];
  return readdirSync(absolute, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && isSource(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

function heldFiles(): string[] {
  return HELD.flatMap(({ dir, name }) =>
    readdirSync(join(REPO_ROOT, dir))
      .filter((file) => name.test(file) && isSource(file))
      .map((file) => join(REPO_ROOT, dir, file)),
  );
}

/** Every name a provider module exports: a held file importing one reaches past the seam. */
function exportedNames(files: string[]): string[] {
  return files.flatMap((file) =>
    [
      ...readFileSync(file, 'utf8').matchAll(
        /^export (?:const|function|class|type|interface|async function) (\w+)/gm,
      ),
    ].map((match) => match[1]!),
  );
}

interface Term {
  term: string;
  what: string;
  /**
   * A camelCase endpoint id can be some other object's method of the same name
   * — `manifestService.getRepository()` — so a member access does not count.
   */
  member?: boolean;
}

function providerTerms(providerFiles: string[]): Term[] {
  return [
    ...GITHUB_FORGE_FIELD_NAMES.map((term) => ({ term, what: 'a GitHub field name' })),
    ...GITHUB_CONNECTOR.definition.endpoints.map(({ endpointId }) => ({
      term: endpointId,
      what: 'a GitHub endpoint id',
      member: true,
    })),
    ...[...Object.values(SHEPHERD_RESPONSE_PRESETS), JOB_LOG_TAIL_PRESET].map((term) => ({
      term,
      what: "a GitHub response transform's name",
    })),
    ...exportedNames(providerFiles.filter((file) => !file.includes('/connectorCatalog/'))).map(
      (term) => ({ term, what: "a name GitHub's provider exports" }),
    ),
  ];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A whole name, never part of a longer one: `getBranch` is not found in
 * `getBranchRules`. Where `member` holds, `x.term` is another object's.
 */
function pattern({ term, member }: { term: string; member?: boolean | undefined }): RegExp {
  return new RegExp(`(?<![\\w$${member === true ? '.' : ''}])${escape(term)}(?![\\w$])`);
}

/** The API definition's id, as a call names it: the Store tag of the same word is not a call. */
const API_ID_IN_A_CALL = new RegExp(`apiId:\\s*['"]${escape(GITHUB_API_ID)}['"]`);

/** Each place a held file names a provider's own term, as `file:line — term (what)`. */
function seamLeaks(files: string[], terms: Term[]): string[] {
  const leaks: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const at = `${relative(REPO_ROOT, file)}:${String(index + 1)}`;
      for (const { term, what, member } of terms) {
        if (pattern({ term, member }).test(line)) leaks.push(`${at} — \`${term}\` (${what})`);
      }
      if (API_ID_IN_A_CALL.test(line)) leaks.push(`${at} — the \`${GITHUB_API_ID}\` API id`);
    });
  }
  return leaks;
}

describe('the forge seam (Plan 340 D3)', () => {
  const providerFiles = GITHUB_PROVIDER.flatMap(filesUnder);
  const held = heldFiles();
  const terms = providerTerms(providerFiles);

  it('holds the skill and poller files, and finds every provider file it names', () => {
    for (const path of GITHUB_PROVIDER) expect(existsSync(join(REPO_ROOT, path)), path).toBe(true);
    const names = held.map((file) => relative(REPO_ROOT, file));
    expect(names).toEqual(
      expect.arrayContaining([
        'packages/platform-artifacts/src/skillCatalog/localPrShepherd.ts',
        'packages/platform-artifacts/src/skillCatalog/localPrShepherdRules.ts',
        'packages/platform-artifacts/src/skillCatalog/localPrShepherdWiring.ts',
        'packages/platform-artifacts/src/skillCatalog/publishLocalChanges.ts',
        'packages/platform-artifacts/src/skillCatalog/publishLocalChangesOverride.ts',
        'apps/aflow-orchestrator/src/services/pullRequestEvents/source.ts',
        'apps/aflow-orchestrator/src/index.ts',
      ]),
    );
    expect(names.some((name) => name.includes('/forge/'))).toBe(false);
  });

  it("finds each field name GitHub's provider declares inside that provider", () => {
    const source = providerFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
    const unused = GITHUB_FORGE_FIELD_NAMES.filter((term) => !pattern({ term }).test(source));
    expect(unused, 'declared as GitHub field names, read nowhere in its provider').toEqual([]);
  });

  it("finds no provider's field name, endpoint, transform or export outside its provider", () => {
    expect(seamLeaks(held, terms)).toEqual([]);
  });
});
