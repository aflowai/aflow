/**
 * Publish hermiticity for applet-kind artifacts: capture the pinned CDN
 * library assets once at publish, verify their bytes against the registry's
 * sha256 pins, and rewrite the draft HTML so the published version renders
 * with no external fetch. A capture that cannot reach the CDN, or receives
 * bytes that do not match the pin, fails the publish — never a partial
 * hermetic version that silently ships CDN refs.
 *
 * react_tsx / html_js artifacts keep their esm.sh import maps: that
 * hermeticity gap predates applets and is deliberately not this path.
 */
import { createHash } from 'node:crypto';
import {
  APPLET_LIBRARY_REGISTRY,
  AppletAssetsManifestSchema,
  type AflowError,
  type AppletAssetManifestEntry,
  type AppletAssetsManifest,
  type AppletLibrary,
  type AppletLibraryEntry,
} from '@aflow/schemas';
import { providerError, validationError } from '@aflow/executor-runtime';
import { buildAppletCsp } from './appletHtmlWrapper.js';

export type AppletAssetFetcher = (url: string) => Promise<Uint8Array>;

export interface HermeticCaptureDeps {
  fetchAsset: AppletAssetFetcher;
  storeBlob: (content: string) => Promise<string>;
  /** Test seam — capture verifies against these pins instead of the registry. */
  registry?: Partial<Record<AppletLibrary, AppletLibraryEntry>>;
}

export interface HermeticApplet {
  html: string;
  htmlRef: string;
  manifest: AppletAssetsManifest;
}

export type HermeticCaptureResult =
  { ok: true; hermetic: HermeticApplet } | { ok: false; error: AflowError };

const ASSET_FETCH_TIMEOUT_MS = 30_000;

export async function defaultAppletAssetFetcher(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

// These patterns match the exact fragments wrapAppletHtml emits — the wrapper
// and this rewriter are two halves of one contract.
const SCRIPT_SRC_RE = /<script src="([^"]+)"><\/script>/g;
const CSS_LINK_RE = /<link rel="stylesheet" href="([^"]+)">/g;
const IMPORT_MAP_RE = /<script type="importmap">([\s\S]*?)<\/script>/;
const CSP_META_RE = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;

function escapeInlineScript(js: string): string {
  return js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

function escapeInlineStyle(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

function toDataModuleUri(js: string): string {
  return `data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`;
}

function umdImportMapUrl(entry: AppletLibraryEntry): string {
  return `https://esm.sh/${entry.specifier ?? entry.id}@${entry.version}`;
}

interface CapturedAsset {
  entry: AppletLibraryEntry;
  asset: 'js' | 'css';
  url: string;
  content: string;
  sha256: string;
  sizeBytes: number;
}

export async function captureHermeticApplet(
  deps: HermeticCaptureDeps,
  draftHtml: string,
): Promise<HermeticCaptureResult> {
  const registry: Partial<Record<AppletLibrary, AppletLibraryEntry>> =
    deps.registry ?? APPLET_LIBRARY_REGISTRY;
  const byJsUrl = new Map<string, AppletLibraryEntry>();
  const byCssUrl = new Map<string, AppletLibraryEntry>();
  const byUmdShimUrl = new Map<string, AppletLibraryEntry>();
  for (const entry of Object.values(registry)) {
    byJsUrl.set(entry.url, entry);
    if (entry.css) byCssUrl.set(entry.css, entry);
    if (entry.loading === 'umd') byUmdShimUrl.set(umdImportMapUrl(entry), entry);
  }

  const scriptSrcs = [...draftHtml.matchAll(SCRIPT_SRC_RE)].map((match) => match[1]!);
  const cssHrefs = [...draftHtml.matchAll(CSS_LINK_RE)].map((match) => match[1]!);
  const importMapMatch = IMPORT_MAP_RE.exec(draftHtml);
  let imports: Record<string, string> = {};
  if (importMapMatch) {
    try {
      const parsed = JSON.parse(importMapMatch[1]!) as { imports?: Record<string, string> };
      imports = parsed.imports ?? {};
    } catch {
      return {
        ok: false,
        error: validationError(
          'applet import map does not parse — cannot capture library assets for hermetic publish',
        ),
      };
    }
  }

  const unknownRef = (what: string, url: string): HermeticCaptureResult => ({
    ok: false,
    error: validationError(
      `applet references a ${what} outside the pinned library registry: ${url} — regenerate the applet before publishing`,
    ),
  });
  for (const src of scriptSrcs) {
    if (!byJsUrl.has(src)) return unknownRef('script', src);
  }
  for (const href of cssHrefs) {
    if (!byCssUrl.has(href)) return unknownRef('stylesheet', href);
  }
  const scriptSrcSet = new Set(scriptSrcs);
  for (const [specifier, url] of Object.entries(imports)) {
    if (byJsUrl.has(url)) continue;
    const umdEntry = byUmdShimUrl.get(url);
    // The window-global shim is only honest when this HTML also loads the UMD
    // bundle: a pre-repoint draft can carry the same esm.sh URL with NO script
    // tag, and shimming it would publish an applet whose import is undefined
    // at load. Refuse and ask for a regenerate instead.
    if (!umdEntry || !scriptSrcSet.has(umdEntry.url)) {
      return unknownRef(`module import ('${specifier}')`, url);
    }
  }

  const wanted: Array<{ entry: AppletLibraryEntry; asset: 'js' | 'css'; url: string }> = [];
  for (const src of scriptSrcs) {
    wanted.push({ entry: byJsUrl.get(src)!, asset: 'js', url: src });
  }
  for (const href of cssHrefs) {
    wanted.push({ entry: byCssUrl.get(href)!, asset: 'css', url: href });
  }
  for (const url of Object.values(imports)) {
    const esmEntry = byJsUrl.get(url);
    if (esmEntry) wanted.push({ entry: esmEntry, asset: 'js', url });
  }

  const captured = new Map<string, CapturedAsset>();
  for (const { entry, asset, url } of wanted) {
    if (captured.has(url)) continue;
    const expectedSha256 = asset === 'js' ? entry.sha256 : entry.cssSha256;
    if (!expectedSha256) {
      return {
        ok: false,
        error: validationError(
          `registry entry '${entry.id}' carries no sha256 pin for its ${asset} asset — cannot verify ${url}`,
        ),
      };
    }
    let bytes: Uint8Array;
    try {
      bytes = await deps.fetchAsset(url);
    } catch (err) {
      return {
        ok: false,
        error: providerError(
          `applet asset capture could not fetch ${url}: ${err instanceof Error ? err.message : String(err)} — publishing an applet requires CDN access to capture its library assets`,
        ),
      };
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== expectedSha256) {
      return {
        ok: false,
        error: providerError(
          `integrity mismatch for ${entry.id} ${asset} asset ${url}: expected sha256 ${expectedSha256}, got ${sha256} — refusing to publish`,
          { retryable: false },
        ),
      };
    }
    captured.set(url, {
      entry,
      asset,
      url,
      content: Buffer.from(bytes).toString('utf8'),
      sha256,
      sizeBytes: bytes.byteLength,
    });
  }

  let html = draftHtml;
  for (const src of scriptSrcs) {
    const asset = captured.get(src)!;
    html = html.replace(
      `<script src="${src}"></script>`,
      () => `<script>\n${escapeInlineScript(asset.content)}\n</script>`,
    );
  }
  for (const href of cssHrefs) {
    const asset = captured.get(href)!;
    html = html.replace(
      `<link rel="stylesheet" href="${href}">`,
      () => `<style>\n${escapeInlineStyle(asset.content)}\n</style>`,
    );
  }
  if (importMapMatch) {
    const hermeticImports: Record<string, string> = {};
    for (const [specifier, url] of Object.entries(imports)) {
      const esmAsset = captured.get(url);
      if (esmAsset) {
        hermeticImports[specifier] = toDataModuleUri(esmAsset.content);
      } else {
        const umdEntry = byUmdShimUrl.get(url)!;
        hermeticImports[specifier] = toDataModuleUri(
          `export default window.${umdEntry.global ?? specifier};`,
        );
      }
    }
    html = html.replace(
      importMapMatch[0],
      () => `<script type="importmap">${JSON.stringify({ imports: hermeticImports })}</script>`,
    );
  }
  html = html.replace(
    CSP_META_RE,
    () => `<meta http-equiv="Content-Security-Policy" content="${buildAppletCsp('data:')}">`,
  );

  const residual = findResidualExternalRef(html);
  if (residual) {
    return {
      ok: false,
      error: validationError(
        `hermetic rewrite left an external reference in the applet HTML: ${residual} — refusing to publish`,
      ),
    };
  }

  const assets: AppletAssetManifestEntry[] = [];
  for (const asset of captured.values()) {
    const payloadRef = await deps.storeBlob(asset.content);
    assets.push({
      library: asset.entry.id,
      asset: asset.asset,
      url: asset.url,
      sha256: asset.sha256,
      sizeBytes: asset.sizeBytes,
      payloadRef,
    });
  }
  const manifest = AppletAssetsManifestSchema.parse({
    capturedAt: new Date().toISOString(),
    assets,
  });
  const htmlRef = await deps.storeBlob(html);

  return { ok: true, hermetic: { html, htmlRef, manifest } };
}

function findResidualExternalRef(html: string): string | null {
  const tagRef = /<script[^>]*\ssrc="(https?:[^"]+)"|<link[^>]*\shref="(https?:[^"]+)"/i.exec(html);
  if (tagRef) return tagRef[1] ?? tagRef[2] ?? null;
  const importMap = IMPORT_MAP_RE.exec(html);
  if (importMap) {
    try {
      const parsed = JSON.parse(importMap[1]!) as { imports?: Record<string, string> };
      for (const url of Object.values(parsed.imports ?? {})) {
        if (!url.startsWith('data:')) return url;
      }
    } catch {
      return 'unparseable import map';
    }
  }
  return null;
}
