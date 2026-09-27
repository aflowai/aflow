/**
 * The packages declared for npm and the manifests that permit publishing agree.
 * A workspace becomes publishable by omission: dropping `private: true` is enough.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const { CONTRACTS, drift, publishableWorkspaces } = (await import(
  join(REPO_ROOT, 'scripts/publishable-contracts.mjs')
)) as {
  CONTRACTS: string[];
  drift: () => string[];
  publishableWorkspaces: () => { name: string; dir: string; version?: string }[];
};

describe('the npm contract surface', () => {
  it('has no drift between what is declared and what the manifests permit', () => {
    // The messages are the point of failing here rather than at release time.
    expect(drift()).toEqual([]);
  });

  it('is exactly the set of workspaces whose manifest permits publishing', () => {
    expect(
      publishableWorkspaces()
        .map((w) => w.name)
        .sort(),
    ).toEqual([...CONTRACTS].sort());
  });

  it('publishes a dependency before whatever declares it', () => {
    // Yarn rewrites `workspace:*` to an exact version when it packs, so a
    // consumer installing the later package resolves the earlier one from the
    // registry. Publishing out of order leaves that unresolvable.
    for (const [index, name] of CONTRACTS.entries()) {
      const dir = publishableWorkspaces().find((w) => w.name === name)?.dir;
      expect(dir, `${name} is declared but not publishable`).toBeDefined();
      for (const dep of dependenciesOf(dir as string)) {
        if (!dep.startsWith('@aflow/')) continue;
        expect(CONTRACTS.indexOf(dep), `${name} depends on unpublished ${dep}`).toBeGreaterThan(-1);
        expect(CONTRACTS.indexOf(dep), `${name} publishes before ${dep}`).toBeLessThan(index);
      }
    }
  });

  it('carries the licence the repository is under', () => {
    for (const { dir } of publishableWorkspaces()) {
      const manifest = readManifest(dir);
      expect(manifest['license'], `${dir} publishes without a licence`).toBe('AGPL-3.0-or-later');
      // Scoped packages default to restricted, which needs a paid plan.
      expect((manifest['publishConfig'] as { access?: string } | undefined)?.access).toBe('public');
    }
  });
});

function readManifest(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf-8')) as Record<
    string,
    unknown
  >;
}

function dependenciesOf(dir: string): string[] {
  return Object.keys(
    (readManifest(dir)['dependencies'] as Record<string, string> | undefined) ?? {},
  );
}
