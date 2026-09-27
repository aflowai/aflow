/**
 * The agent-facing store ops surface applet listings with zero handler or
 * prompt changes — the search summary and get output contracts admit the new
 * kind, and the pure derivations behind preview/install report it correctly.
 */
import { describe, it, expect } from 'vitest';
import { StoreListingGetOutputSchema, StoreListingSummarySchema } from '@aflow/schemas';
import { getCatalogEntry } from '@aflow/platform-artifacts';
import { appletArtifactKey } from './appletArtifact.js';
import {
  deriveListingRequirements,
  derivePlannedArtifacts,
  deriveRegistryArtifactContents,
  provenanceArtifactKey,
} from './storeDerivations.js';

function workBoardEntry() {
  const entry = getCatalogEntry('work-board');
  if (entry === null || entry.kind !== 'applet') {
    throw new Error(`expected the work-board applet listing, got ${entry?.kind ?? 'null'}`);
  }
  return entry;
}

describe('applet listings on the agent store surface', () => {
  it('store.listing.search summary contract admits an applet listing', () => {
    const entry = workBoardEntry();
    const summary = StoreListingSummarySchema.parse({
      ...entry,
      installedState: 'not_installed',
      requirements: deriveListingRequirements(entry),
    });
    expect(summary.kind).toBe('applet');
    expect('payload' in summary).toBe(false);
  });

  it('store.listing.get output contract carries the full applet entry', () => {
    const entry = workBoardEntry();
    const output = StoreListingGetOutputSchema.parse({
      listing: entry,
      installedState: 'not_installed',
      requirements: deriveListingRequirements(entry),
    });
    expect(output.listing.kind).toBe('applet');
  });

  it('an applet listing needs nothing before it can run', () => {
    expect(deriveListingRequirements(workBoardEntry())).toEqual({
      credentialKeys: [],
      oauthIssuers: [],
      needsRepo: false,
      needsModelKey: false,
    });
  });

  it('install preview plans exactly the one ui_artifact', () => {
    const entry = workBoardEntry();
    expect(derivePlannedArtifacts(entry)).toEqual([
      { artifactType: 'ui_artifact', artifactKey: appletArtifactKey(entry.catalogId) },
    ]);
    const contents = deriveRegistryArtifactContents(entry);
    expect([...contents.keys()]).toEqual([
      provenanceArtifactKey({
        artifactType: 'ui_artifact',
        artifactKey: appletArtifactKey(entry.catalogId),
      }),
    ]);
  });
});
