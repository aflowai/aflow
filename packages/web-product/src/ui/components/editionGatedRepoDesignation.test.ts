/**
 * The repository designation is the coding lane's, and the lane is the gate.
 *
 * `isRepoDesignationOffered` is tested directly beside the helper; this pins the
 * wiring, which is the half that rots: the filter chip and the add-menu entry
 * were rendered unconditionally, so a local instance offered designations for a
 * lane it does not compose and the API was right to refuse every run made from
 * one.
 *
 * It reads source because the invariant is about what the tree renders and this
 * package carries no renderable test surface — the integrations page pulls every
 * integration hook in behind it. Same shape as `editionGatedShell.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HEADER_SRC = readFileSync(
  resolve(__dirname, './integrations/IntegrationsHeader.tsx'),
  'utf8',
);
const PAGE_SRC = readFileSync(resolve(__dirname, '../screens/space-integrations.tsx'), 'utf8');

function countOf(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

describe('the integrations page', () => {
  it('asks the lane, through the derivation the Store filters its listings by', () => {
    expect(PAGE_SRC).toContain(
      "import { isRepoDesignationOffered } from '../lib/edition-offers.js'",
    );
    expect(PAGE_SRC).toContain('const edition = useEdition()');
    expect(PAGE_SRC).toContain('const offersRepos = isRepoDesignationOffered(edition)');
  });

  it('gates on that and not on a surface name, which is true in both editions', () => {
    expect(PAGE_SRC).not.toContain("useHasSurface('repo");
  });

  it('hands the answer to both controls that can reach a designation', () => {
    expect(PAGE_SRC).toContain(
      '<FilterChips value={filter} onChange={setFilter} offersRepos={offersRepos} />',
    );
    expect(PAGE_SRC).toContain(
      '<AddIntegrationButton onPick={handlePickAdd} offersRepos={offersRepos} />',
    );
  });

  it('opens no designation form behind either control — a stale deep link, a pick', () => {
    // `setRepoFormTarget({})` is the one call that opens it; every occurrence is
    // guarded, so a `?add=repo` URL kept from a hosted space does nothing here.
    expect(countOf(PAGE_SRC, 'setRepoFormTarget({})')).toBe(2);
    expect(countOf(PAGE_SRC, 'offersRepos) setRepoFormTarget({})')).toBe(2);
  });
});

describe('the integrations header', () => {
  it('offers the Repos filter only where a designation can exist', () => {
    expect(HEADER_SRC).toContain(
      "...(offersRepos ? [{ id: 'repo' as const, label: 'Repos' }] : [])",
    );
    expect(countOf(HEADER_SRC, "label: 'Repos'")).toBe(1);
  });

  it('offers the code-repository kind only there too', () => {
    expect(HEADER_SRC).toContain('{offersRepos && (');
    expect(countOf(HEADER_SRC, 'Code repository')).toBe(1);
    expect(countOf(HEADER_SRC, "onPick('repo')")).toBe(1);
  });
});
