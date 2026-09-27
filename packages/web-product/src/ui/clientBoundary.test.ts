/**
 * Every client component this package publishes still says so in its built output.
 *
 * `'use client'` is what Next splits the module graph at, and a bundler is free to
 * drop it: bundling a barrel that re-exports a client component alongside a server
 * module emits one chunk with the directive gone. Nothing reports that — the
 * package builds, both applications build, and the boundary is simply absent,
 * surfacing later as a hydration or server/client mismatch naming neither this
 * package nor the import. `transpilePackages` cannot restore a directive already
 * removed here.
 *
 * So the assertion is on `dist`, not on `src`. Checking the source would pass in
 * exactly the configuration this exists to catch.
 *
 * **Detected by parsing, not by matching the first line.** A directive may be
 * preceded by comments, which React documents and this codebase does throughout —
 * most components open with a doc comment and declare the boundary after it. A
 * regex anchored at the start of the file misses those in `src` and finds them in
 * `dist`, where the comment has been stripped, and then reports a boundary the
 * build "added". That false positive is what the first version of this guard
 * produced, and it was read as a build defect before it was read as a guard bug.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_SRC = resolve(HERE, '..');
const PKG_DIST = resolve(HERE, '../../dist');

/** Every area the build emits with modules preserved. */
const PRESERVED = ['ui', 'components', 'lib'];

/**
 * Whether a module's directive prologue declares a client boundary.
 *
 * The prologue is the leading run of string-literal expression statements, and it
 * ends at the first statement that is anything else — so a string sitting after
 * executable code is a expression, not a directive, and does not count. Comments
 * are trivia and never interrupt it.
 */
function declaresClientBoundary(code: string, fileName: string): boolean {
  const source = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    false,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteralLike(statement.expression)) {
      return false;
    }
    if (statement.expression.text === 'use client') return true;
  }
  return false;
}

function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [full.slice(base.length + 1)];
  });
}

/** Source modules declaring a boundary, named as their output is. */
function sourceModulesDeclaringClient(): string[] {
  return PRESERVED.flatMap((area) =>
    walk(join(PKG_SRC, area))
      .filter((rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel))
      .filter((rel) => declaresClientBoundary(readFileSync(join(PKG_SRC, area, rel), 'utf8'), rel))
      .map((rel) => join(area, rel.replace(/\.tsx?$/, '.js'))),
  );
}

function emittedModules(): string[] {
  return PRESERVED.flatMap((area) =>
    walk(join(PKG_DIST, area))
      .filter((rel) => rel.endsWith('.js'))
      .map((rel) => join(area, rel)),
  );
}

describe('published client boundaries', () => {
  it('is reading a build', () => {
    // Without this the assertions below pass by finding nothing, which is also
    // what a package that was never built looks like.
    expect(
      existsSync(PKG_DIST),
      `${PKG_DIST} — run \`yarn workspace @aflow/web-product build\``,
    ).toBe(true);
    expect(emittedModules().length).toBeGreaterThan(0);
  });

  it('keeps the boundary on every module that declared one', () => {
    const missing = sourceModulesDeclaringClient().filter((emitted) => {
      const built = join(PKG_DIST, emitted);
      return !existsSync(built) || !declaresClientBoundary(readFileSync(built, 'utf8'), emitted);
    });
    expect(missing).toEqual([]);
  });

  // The same mistake in the other direction: a server module handed the directive
  // moves code to the client that was never meant to run there.
  it('gives the boundary to nothing that did not declare one', () => {
    const declared = new Set(sourceModulesDeclaringClient());
    const leaked = emittedModules()
      .filter((emitted) => !declared.has(emitted))
      .filter((emitted) =>
        declaresClientBoundary(readFileSync(join(PKG_DIST, emitted), 'utf8'), emitted),
      );
    expect(leaked).toEqual([]);
  });

  /**
   * The mirror of the first two, on the source rather than the output: a React
   * hook cannot run on the server, so a module calling one belongs on the client
   * whether or not anything currently imports it from a server component. The
   * barrel is the reason this is not merely tidy — it re-exports by path, so a
   * hook module without a directive fails the build of whatever route first
   * reaches it, a long way from the file that is wrong.
   */
  it('declares the boundary on every module that calls a hook', () => {
    const HOOK_CALL =
      /\b(useState|useEffect|useRef|useCallback|useMemo|useReducer|useLayoutEffect|useContext|useTransition|useSyncExternalStore)\s*\(/;
    const missing = PRESERVED.flatMap((area) =>
      walk(join(PKG_SRC, area))
        .filter((rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel))
        .filter((rel) => {
          const src = readFileSync(join(PKG_SRC, area, rel), 'utf8');
          return HOOK_CALL.test(src) && !declaresClientBoundary(src, rel);
        })
        .map((rel) => join(area, rel)),
    );
    expect(missing).toEqual([]);
  });

  /**
   * The assertion that actually fails when the build is misconfigured.
   *
   * One output per entry keeps a directive on each component's own file whether or
   * not the build bundles, so checking the components alone passes both ways. What
   * differs is the barrel: preserved it re-exports by module path and Next follows
   * the import to a file declaring the boundary; bundled it inlines the body and
   * the directive is gone from the module a consumer loads.
   *
   * The subject is the barrel's own shape, not which modules it happens to name —
   * a client module the barrel does not export is reached through another module
   * of this package, which carries its own file and its own directive.
   */
  it('re-exports rather than inlining what it names', () => {
    const barrel = readFileSync(join(PKG_DIST, 'ui/index.js'), 'utf8');
    const residue = barrel
      .replace(/(?:import|export)[\s\S]*?from\s*['"][^'"]+['"];?/g, '')
      .replace(/export\s*\{[^}]*\};?/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .trim();
    expect(residue).toBe('');
  });
});
