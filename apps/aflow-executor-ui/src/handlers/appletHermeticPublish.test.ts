/**
 * Hermetic capture never hits real CDNs here: fixture bytes stand in for the
 * pinned assets, with the registry's sha256 pins overridden to match. The
 * acceptance is a full-document scan — a published applet's HTML must carry
 * zero external references.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  APPLET_LIBRARY_REGISTRY,
  type AppletLibrary,
  type AppletLibraryEntry,
} from '@aflow/schemas';
import { wrapAppletHtml, buildLibraryInjection } from './appletHtmlWrapper.js';
import { captureHermeticApplet, type HermeticCaptureDeps } from './appletHermeticPublish.js';

const D3 = APPLET_LIBRARY_REGISTRY.d3;
const LEAFLET = APPLET_LIBRARY_REGISTRY.leaflet;
const THREE = APPLET_LIBRARY_REGISTRY.three;

const FIXTURES: Record<string, string> = {
  [D3.url]: 'window.d3 = { fixture: "d3" };',
  [LEAFLET.url]: 'window.L = { fixture: "leaflet" };',
  [LEAFLET.css!]: '.leaflet-fixture { color: green; }',
  [THREE.url]: 'export const fixture = "three";',
};

function sha256Of(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

const FIXTURE_REGISTRY: Partial<Record<AppletLibrary, AppletLibraryEntry>> = {
  d3: { ...D3, sha256: sha256Of(FIXTURES[D3.url]!) },
  leaflet: {
    ...LEAFLET,
    sha256: sha256Of(FIXTURES[LEAFLET.url]!),
    cssSha256: sha256Of(FIXTURES[LEAFLET.css!]!),
  },
  three: { ...THREE, sha256: sha256Of(FIXTURES[THREE.url]!) },
};

interface Harness {
  deps: HermeticCaptureDeps;
  fetchAsset: ReturnType<typeof vi.fn>;
  blobs: Map<string, string>;
}

function makeHarness(overrides?: Partial<HermeticCaptureDeps>): Harness {
  const blobs = new Map<string, string>();
  const fetchAsset = vi.fn(async (url: string): Promise<Uint8Array> => {
    const content = FIXTURES[url];
    if (content === undefined) throw new Error(`connect ECONNREFUSED (${url})`);
    return new Uint8Array(Buffer.from(content, 'utf8'));
  });
  const deps: HermeticCaptureDeps = {
    fetchAsset,
    storeBlob: async (content: string) => {
      const ref = `blob:${blobs.size}`;
      blobs.set(ref, content);
      return ref;
    },
    registry: FIXTURE_REGISTRY,
    ...overrides,
  };
  return { deps, fetchAsset, blobs };
}

const DRAFT_HTML = wrapAppletHtml('const board = document.createElement("div");', [
  'd3',
  'leaflet',
  'three',
]);

describe('captureHermeticApplet', () => {
  it('the draft form really does reference the CDN (the delta being removed)', () => {
    expect(DRAFT_HTML).toContain(`<script src="${D3.url}"></script>`);
    expect(DRAFT_HTML).toContain(`<link rel="stylesheet" href="${LEAFLET.css}">`);
    expect(DRAFT_HTML).toContain(THREE.url);
  });

  it('captures each referenced asset exactly once and records the manifest', async () => {
    const { deps, fetchAsset, blobs } = makeHarness();
    const result = await captureHermeticApplet(deps, DRAFT_HTML);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { manifest } = result.hermetic;
    expect(fetchAsset).toHaveBeenCalledTimes(4);
    expect(manifest.assets).toHaveLength(4);
    const byUrl = new Map(manifest.assets.map((asset) => [asset.url, asset]));
    expect(byUrl.get(D3.url)?.asset).toBe('js');
    expect(byUrl.get(D3.url)?.library).toBe('d3');
    expect(byUrl.get(LEAFLET.css!)?.asset).toBe('css');
    expect(byUrl.get(THREE.url)?.sha256).toBe(sha256Of(FIXTURES[THREE.url]!));
    for (const asset of manifest.assets) {
      expect(blobs.get(asset.payloadRef)).toBe(FIXTURES[asset.url]);
      expect(asset.sizeBytes).toBe(Buffer.byteLength(FIXTURES[asset.url]!, 'utf8'));
    }
    expect(blobs.get(result.hermetic.htmlRef)).toBe(result.hermetic.html);
  });

  it('rewritten HTML contains zero external references', async () => {
    const { deps } = makeHarness();
    const result = await captureHermeticApplet(deps, DRAFT_HTML);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hermetic.html).not.toContain('https://');
    expect(result.hermetic.html).not.toContain('http://');
  });

  it('tightens the CSP to drop CDN origins while keeping data: modules loadable', async () => {
    const { deps } = makeHarness();
    const result = await captureHermeticApplet(deps, DRAFT_HTML);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cspMatch = result.hermetic.html.match(
      /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/,
    );
    expect(cspMatch).not.toBeNull();
    const csp = cspMatch![1]!;
    expect(csp).toContain("script-src 'unsafe-inline' data:");
    expect(csp).toContain('font-src data:');
    expect(csp).not.toContain('cdn.jsdelivr.net');
    expect(csp).not.toContain('esm.sh');
  });

  it('inlines UMD scripts and CSS, and maps module specifiers to data: URIs', async () => {
    const { deps } = makeHarness();
    const result = await captureHermeticApplet(deps, DRAFT_HTML);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const html = result.hermetic.html;

    expect(html).toContain(FIXTURES[D3.url]);
    expect(html).toContain(FIXTURES[LEAFLET.url]);
    expect(html).toContain(`<style>\n${FIXTURES[LEAFLET.css!]}\n</style>`);

    const importMapMatch = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    expect(importMapMatch).not.toBeNull();
    const imports = (JSON.parse(importMapMatch![1]!) as { imports: Record<string, string> })
      .imports;
    const decodeDataUri = (uri: string): string => {
      expect(uri.startsWith('data:text/javascript;base64,')).toBe(true);
      return Buffer.from(uri.slice('data:text/javascript;base64,'.length), 'base64').toString(
        'utf8',
      );
    };
    expect(decodeDataUri(imports['three']!)).toBe(FIXTURES[THREE.url]);
    // Parity: new drafts carry no UMD import-map entries at all.
    expect(imports['d3']).toBeUndefined();
    expect(imports['leaflet']).toBeUndefined();
  });

  it('still shims a pre-repoint draft when the UMD bundle is genuinely loaded', async () => {
    const { deps } = makeHarness();
    // Old wrapper output: UMD script tag AND its esm.sh fallback both present.
    const stale = DRAFT_HTML.replace(
      /<script type="importmap">([\s\S]*?)<\/script>/,
      (m, body: string) => {
        const map = JSON.parse(body) as { imports: Record<string, string> };
        map.imports['d3'] = 'https://esm.sh/d3@7.9.0';
        return `<script type="importmap">${JSON.stringify(map)}</script>`;
      },
    );
    const result = await captureHermeticApplet(deps, stale);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const match = result.hermetic.html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    const imports = (JSON.parse(match![1]!) as { imports: Record<string, string> }).imports;
    const shim = Buffer.from(
      imports['d3']!.slice('data:text/javascript;base64,'.length),
      'base64',
    ).toString('utf8');
    expect(shim).toBe('export default window.d3;');
  });

  it('fails on an integrity mismatch without storing anything', async () => {
    const { deps, blobs } = makeHarness({
      registry: {
        ...FIXTURE_REGISTRY,
        d3: { ...D3, sha256: 'a'.repeat(64) },
      },
    });
    const result = await captureHermeticApplet(deps, DRAFT_HTML);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/integrity mismatch/);
    expect(result.error.message).toContain(D3.url);
    expect(result.error.retryable).toBe(false);
    expect(blobs.size).toBe(0);
  });

  it('fails with a clear error when the CDN is unreachable', async () => {
    const { deps } = makeHarness({
      fetchAsset: vi.fn(async (url: string): Promise<Uint8Array> => {
        throw new Error(`getaddrinfo ENOTFOUND (${url})`);
      }),
    });
    const result = await captureHermeticApplet(deps, DRAFT_HTML);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('could not fetch');
    expect(result.error.message).toContain('CDN access');
  });

  it('refuses HTML referencing a script outside the registry', async () => {
    const { deps, fetchAsset } = makeHarness();
    const tampered = DRAFT_HTML.replace(
      '</head>',
      '<script src="https://evil.example/x.js"></script>\n</head>',
    );
    const result = await captureHermeticApplet(deps, tampered);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('https://evil.example/x.js');
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it('a library-free applet becomes hermetic with an empty manifest and no fetches', async () => {
    const { deps, fetchAsset } = makeHarness();
    const html = wrapAppletHtml('document.body.textContent = "hi";', []);
    const result = await captureHermeticApplet(deps, html);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fetchAsset).not.toHaveBeenCalled();
    expect(result.hermetic.manifest.assets).toHaveLength(0);
    expect(result.hermetic.html).not.toContain('https://');
  });
});

describe('buildLibraryInjection (draft form)', () => {
  it('UMD entries are window-global only — no esm.sh fallback the published shim cannot honor', () => {
    const { scriptTags, importMap } = buildLibraryInjection(['d3', 'maplibre']);
    expect(scriptTags).toContain(APPLET_LIBRARY_REGISTRY.d3.url);
    expect(scriptTags).toContain(APPLET_LIBRARY_REGISTRY.maplibre.url);
    expect(importMap).not.toContain('esm.sh');
  });

  it('refuses a pre-repoint draft whose import map names a UMD lib with no script tag', async () => {
    const { deps, fetchAsset } = makeHarness();
    // The old draft wrapper emitted this esm.sh fallback URL for UMD libs;
    // shimming it without the UMD bundle present would publish a dead applet.
    const stale = DRAFT_HTML.replace('<script type="importmap">', '').replace(
      '</head>',
      `<script type="importmap">${JSON.stringify({
        imports: { tone: 'https://esm.sh/tone@15.0.4' },
      })}</script>\n</head>`,
    );
    const result = await captureHermeticApplet(deps, stale);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('regenerate');
    expect(fetchAsset).not.toHaveBeenCalled();
  });
});
