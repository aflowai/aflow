/**
 * Every applet listing the registry ships must synthesize a valid install
 * seed. The founding failure: the film view's source outgrew the inline
 * payload cap, the seed schema still carried that cap, and every install,
 * update and update-preview of the listing 500d at the parse — the registry
 * published an applet no space could take.
 */
import { describe, expect, it } from 'vitest';
import { APPLET_CATALOG } from '@aflow/platform-artifacts';
import { appletSeedForEntry } from './appletArtifact.js';

describe('appletSeedForEntry', () => {
  it('synthesizes a valid seed for every applet listing the registry ships', () => {
    expect(APPLET_CATALOG.length).toBeGreaterThan(0);
    for (const entry of APPLET_CATALOG) {
      const seed = appletSeedForEntry(entry);
      expect(seed.bundleArtifactKey).toBe(`${entry.catalogId}:applet`);
      expect(seed.source.length).toBeGreaterThan(0);
    }
  });
});
