/**
 * The package may not import itself.
 *
 * A module inside `@aflow/web-product` that imports `@aflow/web-product/ui`
 * closes a cycle through the barrel that also exports it. Bundlers resolve a
 * cycle by picking an evaluation order, and the order they pick can put a
 * module's own binding in its temporal dead zone at the moment a sibling reads
 * it. What reaches the browser then is
 * `Uncaught ReferenceError: Cannot access 'u7' before initialization` — a
 * minified name, in a stack of bundler frames, naming nothing an author wrote.
 *
 * `StepNode` did this. It imported two helpers from the barrel that exports
 * `StepNode`, and the whole agent editor — and every route whose chunk included
 * it — failed to evaluate in production while every test, typecheck and build
 * passed.
 *
 * Type-only imports are erased before a bundle exists and cannot cycle, so they
 * are allowed and are often the honest spelling for a shared contract.
 *
 * The subject is `@aflow/web-product/ui` specifically. The root entry is
 * bundled where the `ui` tree is emitted module-per-file, so a relative path
 * from one into the other names a file `dist` does not contain — the package
 * specifier is how those two outputs reach each other. It closes no cycle
 * either, because the root entry re-exports nothing from `ui`.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const SRC = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Every `import … from '@aflow/web-product…'` that survives to runtime. */
function valueSelfImports(source: string): string[] {
  const found: string[] = [];
  // `[^;]` rather than `[\s\S]`: a lazy any-character clause spans from an
  // earlier `import` to this statement's `from`, which reads the wrong
  // statement's `type` keyword and reports an erased import as a cycle.
  for (const match of source.matchAll(
    /import\s+(type\s+)?([^;]*?)from\s*'(@aflow\/web-product\/ui[^']*)'/g,
  )) {
    const [, typeKeyword, clause, specifier] = match;
    if (typeKeyword !== undefined) continue;
    const names = (clause ?? '')
      .replace(/[{}]/g, '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    // `import { type A, type B } from …` is erased the same way the keyword form is.
    if (names.length > 0 && names.every((name) => name.startsWith('type '))) continue;
    found.push(specifier as string);
  }
  return found;
}

describe('the shared product', () => {
  it('never imports itself', () => {
    const offenders = sourceFiles(SRC).flatMap((file) =>
      valueSelfImports(readFileSync(file, 'utf8')).map(
        (specifier) => `${relative(SRC, file)} -> ${specifier}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
