import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { installIsStale } from './installState.mjs';

function checkout({ lockAt, installedAt }) {
  const repo = mkdtempSync(join(tmpdir(), 'install-state-'));
  writeFileSync(join(repo, 'yarn.lock'), '');
  utimesSync(join(repo, 'yarn.lock'), lockAt, lockAt);
  if (installedAt !== undefined) {
    mkdirSync(join(repo, 'node_modules'));
    writeFileSync(join(repo, 'node_modules', '.yarn-state.yml'), '');
    utimesSync(join(repo, 'node_modules', '.yarn-state.yml'), installedAt, installedAt);
  }
  return repo;
}

describe('installIsStale', () => {
  it('is stale when the lockfile changed after the last install', () => {
    expect(installIsStale(checkout({ lockAt: 2_000, installedAt: 1_000 }))).toBe(true);
  });

  it('is current when the install ran after the lockfile last changed', () => {
    expect(installIsStale(checkout({ lockAt: 1_000, installedAt: 2_000 }))).toBe(false);
  });

  it('is stale when nothing was ever installed', () => {
    expect(installIsStale(checkout({ lockAt: 1_000, installedAt: undefined }))).toBe(true);
  });
});
