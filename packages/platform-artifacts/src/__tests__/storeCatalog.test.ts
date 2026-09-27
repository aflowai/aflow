import { describe, it, expect, vi } from 'vitest';
import { CatalogEntrySchema, type ComposedLanes } from '@aflow/schemas';
import { STORE_CATALOG, listCatalog, getCatalogEntry } from '../storeCatalog/index.js';
import { issuerHosts } from '../storeCatalog/hostManifest.js';
import { SKILL_CATALOG } from '../skillCatalog/index.js';
import { SKILL_BUNDLE_CATALOG } from '../skillBundleCatalog.js';
import { CONNECTOR_CATALOG } from '../connectorCatalog/index.js';
import { APPLET_CATALOG } from '../appletCatalog/index.js';

// Lane composition is what `listCatalog` filters by, so a facade assertion
// about the registries names the lanes it reads them under; the withholding
// itself is `storeCatalogComposedLanes.test.ts`.
const EVERY_LANE: ComposedLanes = {
  edition: 'enterprise',
  codeLane: 'present',
  hostLane: 'present',
};

describe('store catalog facade', () => {
  it('wraps every entry from the contributing registries', () => {
    expect(STORE_CATALOG.length).toBe(
      SKILL_BUNDLE_CATALOG.length + CONNECTOR_CATALOG.length + APPLET_CATALOG.length,
    );
    expect(listCatalog({ kind: 'bundle', lanes: EVERY_LANE }).length).toBe(
      SKILL_BUNDLE_CATALOG.length,
    );
    expect(listCatalog({ kind: 'connector', lanes: EVERY_LANE }).length).toBe(
      CONNECTOR_CATALOG.length,
    );
    expect(listCatalog({ kind: 'applet', lanes: EVERY_LANE }).length).toBe(APPLET_CATALOG.length);
  });

  it('never lists a skill as a standalone listing', () => {
    expect(SKILL_CATALOG.length).toBeGreaterThan(0);
    for (const skill of SKILL_CATALOG) {
      expect(getCatalogEntry(skill.catalogId)).toBeNull();
    }
  });

  it('every listing parses through CatalogEntrySchema', () => {
    for (const entry of listCatalog()) {
      const result = CatalogEntrySchema.safeParse(entry);
      expect(
        result.success,
        result.success
          ? undefined
          : `${entry.catalogId}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      ).toBe(true);
    }
  });

  it('derives unlisted from the legacy hidden flag and strips hidden from the payload', () => {
    const visibleBundle = SKILL_BUNDLE_CATALOG.find((b) => !b.hidden);
    expect(visibleBundle).toBeDefined();
    expect(getCatalogEntry(visibleBundle!.bundleId)?.status).toBe('published');

    const hiddenBundle = SKILL_BUNDLE_CATALOG.find((b) => b.hidden === true);
    expect(hiddenBundle).toBeDefined();
    const bundleListing = getCatalogEntry(hiddenBundle!.bundleId);
    expect(bundleListing?.status).toBe('unlisted');
    expect(bundleListing && 'hidden' in bundleListing.payload).toBe(false);
  });

  it('connector host manifests carry the definition host', () => {
    const github = getCatalogEntry('github');
    expect(github?.kind).toBe('connector');
    expect(github?.hostManifest.apiHosts).toContain('api.github.com');

    const jira = getCatalogEntry('jira-cloud');
    expect(jira?.hostManifest.apiHosts).toContain('*.atlassian.net');
  });

  it('bundle host manifests cover bundled definitions and binding egress', () => {
    const kaggle = getCatalogEntry('kaggle-competition');
    expect(kaggle?.hostManifest.apiHosts).toEqual(
      expect.arrayContaining([
        'www.kaggle.com',
        'storage.googleapis.com',
        '*.storage.googleapis.com',
        'www.googleapis.com',
      ]),
    );
  });

  it('issuer hosts cover curated endpoint hosts for discovery-based issuers', () => {
    expect(issuerHosts('google')).toEqual(['accounts.google.com', 'oauth2.googleapis.com']);
    expect(issuerHosts('microsoft')).toEqual(['login.microsoftonline.com']);
    expect(issuerHosts('github')).toEqual(['github.com']);
    expect(issuerHosts('not-a-registered-issuer')).toEqual([]);
  });

  it('filters by status', () => {
    const unlisted = listCatalog({ status: 'unlisted' });
    expect(unlisted.length).toBeGreaterThan(0);
    expect(unlisted.every((e) => e.status === 'unlisted')).toBe(true);
    const published = listCatalog({ kind: 'connector', status: 'published' });
    expect(published.map((e) => e.catalogId)).toEqual(
      CONNECTOR_CATALOG.filter((e) => !e.hidden).map((e) => e.catalogId),
    );
  });

  it('getCatalogEntry returns null for unknown ids', () => {
    expect(getCatalogEntry('no-such-listing')).toBeNull();
  });

  it('excludes hidden fixtures entirely in production while visible listings survive', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    try {
      const prod = await import('../storeCatalog/index.js');
      expect(prod.getCatalogEntry('test-setup-bundle')).toBeNull();
      expect(prod.getCatalogEntry('test-two-skill-bundle')).toBeNull();
      expect(prod.listCatalog({ status: 'unlisted' })).toEqual([]);
      expect(prod.getCatalogEntry('github')).not.toBeNull();
      expect(prod.STORE_CATALOG.length).toBe(
        STORE_CATALOG.filter((entry) => entry.status !== 'unlisted').length,
      );
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
