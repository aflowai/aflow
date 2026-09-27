/**
 * Applet HTML wrapper — generates the standalone iframe document.
 *
 * Injects library script tags (UMD + ESM import map), CSP meta tag,
 * theme CSS, and the full Phoenix host protocol (postMessage IPC).
 */
import {
  type AppletLibrary,
  type AppletLibraryEntry,
  type ValidationDiagnostic,
  APPLET_LIBRARY_REGISTRY,
} from '@aflow/schemas';
import {
  DS_THEME_CSS,
  isCompilerResolvedImport,
  REACT_RUNTIME_IMPORT_MAP,
  REACT_RUNTIME_ORIGIN,
  rewriteDefaultExport,
  validateAndCompile,
} from './compiler.js';
import { AFLOW_HOST_PROTOCOL_JS, THEME_LISTENER_JS } from './hostProtocol.js';

// ---------------------------------------------------------------------------
// Host protocol boilerplate — injected into every applet iframe
// ---------------------------------------------------------------------------

const PHOENIX_HOST_PROTOCOL_JS = `
// Phoenix host protocol — postMessage IPC with parent frame
const parent = window.parent;

// Notify parent that iframe is ready to receive data
parent.postMessage({ type: 'phoenix:ready' }, '*');

// Report height changes to parent for auto-resize
new ResizeObserver(() => {
  parent.postMessage({ type: 'phoenix:resize', height: document.body.scrollHeight }, '*');
}).observe(document.body);

// Forward runtime errors to parent
window.addEventListener('error', (e) => {
  parent.postMessage({
    type: 'phoenix:error',
    message: e.message,
    filename: e.filename,
    line: e.lineno,
  }, '*');
});

// Listen for data injection and dispatch as CustomEvent
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  if (!event.data || typeof event.data.type !== 'string') return;
  if (event.data.type === 'phoenix:data') {
    window.dispatchEvent(new CustomEvent('phoenixdata', { detail: event.data.payload || {} }));
  }
});
`;

// ---------------------------------------------------------------------------
// Library injection helpers
// ---------------------------------------------------------------------------

/** Extract unique CDN origins from library URLs for CSP script-src / font-src. */
export function computeCspOrigins(libraries: AppletLibrary[]): string {
  const origins = new Set<string>();
  for (const libId of libraries) {
    const entry = APPLET_LIBRARY_REGISTRY[libId];
    try {
      const url = new URL(entry.url);
      origins.add(url.origin);
    } catch {
      // Skip malformed URLs
    }
    if (entry.css) {
      try {
        const cssUrl = new URL(entry.css);
        origins.add(cssUrl.origin);
      } catch {
        // Skip
      }
    }
  }
  return [...origins].join(' ');
}

interface LibraryInjection {
  /** UMD <script src="..."> tags */
  scriptTags: string;
  /** <link rel="stylesheet"> tags for libraries with CSS */
  cssLinks: string;
  /** <script type="importmap"> block for ESM libraries (empty string if none) */
  importMap: string;
}

/**
 * Build the HTML fragments for injecting libraries into the iframe.
 * `extraImports` seeds the import map with modules the shell itself resolves
 * (the React runtime), so one document never carries two import maps.
 */
export function buildLibraryInjection(
  libraries: AppletLibrary[],
  extraImports: Record<string, string> = {},
): LibraryInjection {
  const umdTags: string[] = [];
  const cssTags: string[] = [];
  const esmImports: Record<string, string> = { ...extraImports };

  for (const libId of libraries) {
    const entry: AppletLibraryEntry = APPLET_LIBRARY_REGISTRY[libId];

    const specifier = entry.specifier ?? libId;
    if (entry.loading === 'esm') {
      esmImports[specifier] = entry.url;
    } else {
      // UMD is window.<global> only — a draft-time esm.sh import-map fallback
      // would carry named exports the hermetic published shim cannot provide,
      // so the same import would work in the draft and break after publish.
      umdTags.push(`<script src="${entry.url}"></script>`);
    }

    if (entry.css) {
      cssTags.push(`<link rel="stylesheet" href="${entry.css}">`);
    }
  }

  const importMap =
    Object.keys(esmImports).length > 0
      ? `<script type="importmap">${JSON.stringify({ imports: esmImports })}</script>`
      : '';

  return {
    scriptTags: umdTags.join('\n'),
    cssLinks: cssTags.join('\n'),
    importMap,
  };
}

// ---------------------------------------------------------------------------
// Main wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap applet source code in a complete, self-contained HTML document
 * with CSP, library injection, theme support, and host protocol.
 */
/**
 * Deny-by-default applet CSP. `extraSrc` extends script-src/font-src: CDN
 * origins for the draft form, `data:` for the hermetic published form.
 */
export function buildAppletCsp(extraSrc: string): string {
  const extra = extraSrc ? ` ${extraSrc}` : '';
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline'${extra}`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    `font-src${extra}`,
    "connect-src 'none'",
    'media-src blob: data:',
    'worker-src blob:',
  ].join('; ');
}

const APPLET_BASE_CSS = `${DS_THEME_CSS}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; background: var(--ds-bg-surface); color: var(--ds-text-primary); font-family: system-ui, -apple-system, sans-serif; }
body { overflow: hidden; }`;

export function wrapAppletHtml(
  source: string,
  libraries: AppletLibrary[],
  sampleData?: Record<string, unknown>,
): string {
  const cspOrigins = computeCspOrigins(libraries);
  const { scriptTags, cssLinks, importMap } = buildLibraryInjection(libraries);
  const csp = buildAppletCsp(cspOrigins);

  // Initial data injection (if sampleData provided)
  const initialDataJs = sampleData
    ? `\n// Inject initial data\nwindow.dispatchEvent(new CustomEvent('phoenixdata', { detail: ${JSON.stringify(sampleData)} }));`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
${cssLinks}
${scriptTags}
${importMap}
<style>
${APPLET_BASE_CSS}
</style>
</head>
<body>
<script type="module">
${source}
</script>
<script>
${THEME_LISTENER_JS}
${PHOENIX_HOST_PROTOCOL_JS}
${AFLOW_HOST_PROTOCOL_JS}${initialDataJs}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// React-shaped views
// ---------------------------------------------------------------------------

/**
 * Mounts the compiled view and re-renders it on every host state push. The
 * 'aflowstate' detail — `{ state, version, viewer, seats }` — is the whole
 * prop surface, so the view has no way to read anything the host did not send.
 */
const APPLET_REACT_MOUNT_JS = `
const { default: __React } = await import('react');
const { createRoot: __createRoot } = await import('react-dom/client');

let __appletProps = {};
let __appletRoot = null;

const __AppletView = typeof __phoenix_default_export !== 'undefined'
  ? __phoenix_default_export
  : () => __React.createElement(
      'div',
      { style: { padding: '16px', color: 'var(--ds-text-muted)' } },
      'This applet view exports no component.',
    );

function __renderApplet() {
  if (!__appletRoot) __appletRoot = __createRoot(document.getElementById('root'));
  __appletRoot.render(__React.createElement(__AppletView, __appletProps));
}

window.addEventListener('aflowstate', (event) => {
  __appletProps = event.detail;
  __renderApplet();
});

__renderApplet();
parent.postMessage({ type: 'phoenix:ready' }, '*');

new ResizeObserver(() => {
  parent.postMessage({ type: 'phoenix:resize', height: document.body.scrollHeight }, '*');
}).observe(document.body);

window.addEventListener('error', (e) => {
  parent.postMessage({
    type: 'phoenix:error',
    message: e.message,
    filename: e.filename,
    line: e.lineno,
  }, '*');
});
`;

function wrapAppletReactHtml(compiledCode: string, libraries: AppletLibrary[]): string {
  const { scriptTags, cssLinks, importMap } = buildLibraryInjection(
    libraries,
    REACT_RUNTIME_IMPORT_MAP,
  );
  // The React runtime rides script-src: a module import has the "script"
  // destination, so connect-src stays 'none' and the view keeps no channel
  // it could exfiltrate state over.
  const csp = buildAppletCsp([computeCspOrigins(libraries), REACT_RUNTIME_ORIGIN].join(' ').trim());

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
${cssLinks}
${scriptTags}
${importMap}
<style>
${APPLET_BASE_CSS}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div id="root"></div>
<script>
${THEME_LISTENER_JS}
${AFLOW_HOST_PROTOCOL_JS}
</script>
<script type="module">
${rewriteDefaultExport(compiledCode)}
${APPLET_REACT_MOUNT_JS}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// View shape
// ---------------------------------------------------------------------------

/**
 * `plain_dom` ships as the module it already is; `react_tsx` is TSX and is a
 * syntax error until the compiler has been over it.
 */
export type AppletViewShape = 'react_tsx' | 'plain_dom';

/**
 * Which of the two a view is. Reaching for something only the compiler
 * resolves, or handing back a component instead of painting the DOM itself,
 * are the two things only a compiled-and-mounted view can do — either one
 * settles it. A declared applet library is neither: the iframe's own import
 * map answers for it, and a plain-DOM view that uses one stays plain.
 */
export function appletViewShape(source: string): AppletViewShape {
  if (/(?:^|\n)\s*export\s+default\s/.test(source)) return 'react_tsx';
  const imports = source.matchAll(
    /(?:^|\n)\s*import\s+(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/g,
  );
  for (const match of imports) {
    if (isCompilerResolvedImport(match[1]!)) return 'react_tsx';
  }
  return 'plain_dom';
}

export interface AppletViewHtmlResult {
  shape: AppletViewShape;
  /** Null when a React-shaped view did not compile — the diagnostics say why. */
  html: string | null;
  diagnostics: ValidationDiagnostic[];
  /** The compiled module, for the React shape only. */
  compiledCode?: string;
}

/**
 * The iframe document for an applet view, whichever shape it is. Every caller
 * that turns view source into HTML goes through here: dropping a React view
 * into the wrapper verbatim publishes a syntax error, and putting a plain-DOM
 * view behind the React shell publishes a blank frame.
 */
export async function buildAppletViewHtml(
  source: string,
  libraries: AppletLibrary[],
  options: {
    catalogComponentNames?: string[];
    sampleData?: Record<string, unknown>;
  } = {},
): Promise<AppletViewHtmlResult> {
  const shape = appletViewShape(source);
  if (shape === 'plain_dom') {
    return {
      shape,
      html: wrapAppletHtml(source, libraries, options.sampleData),
      diagnostics: [],
    };
  }

  const compiled = await validateAndCompile(
    source,
    'react_tsx',
    [],
    options.catalogComponentNames ?? [],
  );
  if (!compiled.valid || compiled.compiledCode === undefined) {
    return { shape, html: null, diagnostics: compiled.diagnostics };
  }
  return {
    shape,
    html: wrapAppletReactHtml(compiled.compiledCode, libraries),
    diagnostics: compiled.diagnostics,
    compiledCode: compiled.compiledCode,
  };
}

/**
 * An external reference the wrap did not put there — a library the source
 * reached for that no capture inlined. The React runtime the shell resolves
 * against is pinned by the platform, so it is not one of those.
 */
export function findUnpinnedExternalRef(html: string): string | null {
  const pinned = new Set<string>([
    ...Object.values(REACT_RUNTIME_IMPORT_MAP),
    REACT_RUNTIME_ORIGIN,
  ]);
  for (const match of html.replace(/data:[^"'\s]*/g, '').matchAll(/https?:\/\/[^\s"'<>;]+/g)) {
    if (!pinned.has(match[0])) return match[0];
  }
  return null;
}
