/**
 * The applet iframe document, for both view shapes.
 *
 * A React view dropped into the wrapper verbatim is a SyntaxError and a blank
 * frame, so the shape the wrap is holding is the thing under test: the React
 * shape must come out as plain JS with every bare specifier resolved by the
 * document's own import map, and the plain-DOM shape must come out byte for
 * byte what it came out before.
 */
import { describe, expect, it } from 'vitest';
import {
  appletViewShape,
  buildAppletViewHtml,
  findUnpinnedExternalRef,
  REACT_RUNTIME_IMPORT_MAP,
  validateAndCompile,
  wrapAppletHtml,
} from './index.js';

const REACT_VIEW = `
import React from 'react';
import { Button, Text } from '@aflow/design-system';

export default function Demo({ state, viewer }) {
  const [draft, setDraft] = React.useState('');
  return (
    <div>
      <Text>{state?.title ?? 'untitled'}</Text>
      <Button disabled={viewer?.spaceRole === 'viewer'} onClick={() => window.aflow.act('rename', { title: draft })}>
        Rename
      </Button>
    </div>
  );
}
`;

const PLAIN_DOM_VIEW = `
const root = document.createElement('div');
document.body.appendChild(root);
window.addEventListener('aflowstate', (event) => {
  root.textContent = String(event.detail.state.title || '');
});
`;

function moduleScripts(html: string): string[] {
  return [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map(
    (match) => match[1]!,
  );
}

function importMapOf(html: string): Record<string, string> {
  const match = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  if (match === null) return {};
  return (JSON.parse(match[1]!) as { imports?: Record<string, string> }).imports ?? {};
}

/** The compiler's own js loader is the parser — JSX fails it, plain JS does not. */
async function parsesAsPlainJs(code: string): Promise<string[]> {
  const result = await validateAndCompile(code, 'html_js', [], []);
  return result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
}

function bareSpecifiers(code: string): string[] {
  const matches = code.matchAll(/(?:^|\n)\s*import\s+(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/g);
  return [...matches]
    .map((match) => match[1]!)
    .filter((s) => !s.startsWith('.') && !s.startsWith('/'));
}

describe('applet view shape', () => {
  it('reads a view that imports react or hands back a component as React-shaped', () => {
    expect(appletViewShape(REACT_VIEW)).toBe('react_tsx');
    expect(appletViewShape('export default function View() { return null; }')).toBe('react_tsx');
  });

  it('reads a view that paints the DOM itself as plain', () => {
    expect(appletViewShape(PLAIN_DOM_VIEW)).toBe('plain_dom');
  });

  it('leaves a plain view that uses a declared applet library plain', () => {
    expect(appletViewShape(`import * as THREE from 'three';\n${PLAIN_DOM_VIEW}`)).toBe('plain_dom');
  });
});

describe('a React-shaped applet view', () => {
  it('is a syntax error before compilation — the defect the wrap has to close', async () => {
    expect(await parsesAsPlainJs(REACT_VIEW)).toHaveLength(1);
  });

  it('compiles to a module that parses as plain JS', async () => {
    const built = await buildAppletViewHtml(REACT_VIEW, []);
    expect(built.shape).toBe('react_tsx');
    expect(built.html).not.toBeNull();
    const scripts = moduleScripts(built.html!);
    expect(scripts).toHaveLength(1);
    expect(await parsesAsPlainJs(scripts[0]!)).toEqual([]);
  });

  it('resolves every bare specifier it carries through its own import map', async () => {
    const built = await buildAppletViewHtml(REACT_VIEW, []);
    const imports = importMapOf(built.html!);
    expect(imports).toMatchObject(REACT_RUNTIME_IMPORT_MAP);
    for (const specifier of bareSpecifiers(moduleScripts(built.html!)[0]!)) {
      expect(imports[specifier]).toBeDefined();
    }
  });

  it('bundles the design-system shim rather than reaching for it at runtime', async () => {
    const built = await buildAppletViewHtml(REACT_VIEW, []);
    expect(bareSpecifiers(moduleScripts(built.html!)[0]!)).not.toContain('@aflow/design-system');
    expect(findUnpinnedExternalRef(built.html!)).toBeNull();
  });

  it('mounts the host state push as the whole prop surface', async () => {
    const built = await buildAppletViewHtml(REACT_VIEW, []);
    expect(built.html).toContain("window.addEventListener('aflowstate'");
    expect(built.html).toContain('window.aflow');
    expect(built.html).toContain("parent.postMessage({ type: 'phoenix:ready' }, '*')");
  });

  it('keeps the applet CSP — the React runtime rides script-src, never connect-src', async () => {
    const built = await buildAppletViewHtml(REACT_VIEW, []);
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(built.html!);
    expect(csp![1]).toContain("script-src 'unsafe-inline' https://esm.sh");
    expect(csp![1]).toContain("connect-src 'none'");
    expect(csp![1]).toContain('media-src blob: data:');
  });

  it('reports diagnostics instead of HTML when the view does not compile', async () => {
    const built = await buildAppletViewHtml(`import React from 'react';\nexport default (`, []);
    expect(built.html).toBeNull();
    expect(built.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });
});

describe('a plain-DOM applet view', () => {
  it('wraps exactly as it did before the React path existed', async () => {
    const built = await buildAppletViewHtml(PLAIN_DOM_VIEW, []);
    expect(built.shape).toBe('plain_dom');
    expect(built.html).toBe(wrapAppletHtml(PLAIN_DOM_VIEW, []));
    expect(built.compiledCode).toBeUndefined();
  });

  it('carries no import map and no external reference', async () => {
    const built = await buildAppletViewHtml(PLAIN_DOM_VIEW, []);
    expect(importMapOf(built.html!)).toEqual({});
    expect(findUnpinnedExternalRef(built.html!)).toBeNull();
    expect(await parsesAsPlainJs(moduleScripts(built.html!)[0]!)).toEqual([]);
  });
});

describe('external references', () => {
  it('names a URL the wrap did not pin', () => {
    expect(findUnpinnedExternalRef('<script src="https://cdn.example.com/x.js"></script>')).toBe(
      'https://cdn.example.com/x.js',
    );
  });

  it('ignores captured data URIs and the pinned React runtime', () => {
    const pinned = Object.values(REACT_RUNTIME_IMPORT_MAP).join(' ');
    expect(
      findUnpinnedExternalRef(`data:text/javascript;base64,aHR0cHM6Ly94 ${pinned}`),
    ).toBeNull();
  });
});

/**
 * The mount shell is the only thing joining the host's state push to the view's
 * props. Severing it leaves a frame that renders once and then never moves,
 * which no snapshot of the document can see — so this runs the shell.
 */
describe('the React shell mounts host state as the whole prop surface', () => {
  async function runShell(html: string): Promise<{
    propsSeen: unknown[];
    dispatch: (detail: unknown) => void;
  }> {
    const vm = await import('node:vm');
    const module = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
    if (module === undefined) throw new Error('the document carries no module script');
    // Only the mount shell is under test; the compiled view above it carries the
    // bare specifiers the document's import map answers, which a classic script
    // cannot resolve.
    const shellAt = module.indexOf('let __appletProps');
    if (shellAt < 0) throw new Error('the module script carries no mount shell');

    const propsSeen: unknown[] = [];
    const listeners = new Map<string, (event: unknown) => void>();
    const context = {
      __React: {
        createElement: (type: unknown, props: unknown) => {
          if (typeof type === 'function') propsSeen.push(props);
          return { type, props };
        },
      },
      __createRoot: () => ({ render: () => undefined }),
      __phoenix_default_export: () => null,
      window: {
        addEventListener: (name: string, handler: (event: unknown) => void) => {
          listeners.set(name, handler);
        },
      },
      document: { getElementById: () => ({}) },
      parent: { postMessage: () => undefined },
      // Browser globals the bundled shim reaches for at module scope; the vm has
      // no DOM and the shell under test never calls into them.
      ResizeObserver: class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
      matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
    };
    vm.createContext(context);
    new vm.Script(module.slice(shellAt)).runInContext(context);
    return {
      propsSeen,
      dispatch: (detail) => listeners.get('aflowstate')?.({ detail }),
    };
  }

  it('hands the view exactly what the host pushed, on every push', async () => {
    const built = await buildAppletViewHtml(REACT_VIEW, []);
    const shell = await runShell(built.html ?? '');
    const pushed = { state: { shots: { a: 1 } }, version: 7, viewer: { userId: 'u1' }, seats: [] };
    shell.dispatch(pushed);
    await new Promise((resolve) => setImmediate(resolve));

    // The last render must carry the push verbatim — not a merge, not a subset.
    expect(shell.propsSeen.at(-1)).toEqual(pushed);
  });

  it('re-renders on a second push rather than freezing on the first', async () => {
    const built = await buildAppletViewHtml(REACT_VIEW, []);
    const shell = await runShell(built.html ?? '');
    shell.dispatch({ state: { v: 1 }, version: 1, viewer: null, seats: [] });
    shell.dispatch({ state: { v: 2 }, version: 2, viewer: null, seats: [] });
    await new Promise((resolve) => setImmediate(resolve));

    expect((shell.propsSeen.at(-1) as { version: number }).version).toBe(2);
  });
});
