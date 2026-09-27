/**
 * Nothing this package publishes resolves back into an application.
 *
 * The product is shared and the applications are not, so a module here reaching
 * into `apps/` is a dependency the other application does not have. It builds
 * anyway in a monorepo — every path exists — and fails when the tree is cut, or
 * when the second application tries to use what the first can.
 *
 * **Resolved, not pattern-matched.** The last attempt at this walked `@/…`
 * specifiers with a regular expression and missed relative ones, so components
 * importing `./providers` were moved although providers stayed. The same blind
 * spot then bit in reverse. A specifier's spelling is not the question — what it
 * resolves to is — so this asks the compiler, with the same options the file is
 * actually compiled under, and covers imports, `export … from`, and dynamic
 * `import()` with a literal argument.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '../..');
const REPO = resolve(PKG, '../..');

/** Each compilation in this package, because they resolve modules differently. */
const PROJECTS = ['tsconfig.json', 'src/ui/tsconfig.json'];

function optionsFor(configName: string): ts.CompilerOptions {
  const configPath = join(PKG, configName);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(read.error, `${configName} is unreadable`).toBeUndefined();

  // The base path has to be the config's own directory, and the filename has to be
  // passed: `extends`, `rootDir`, `include` and `references` are all resolved
  // against it. Parsing `src/ui/tsconfig.json` from the package root silently
  // produced different options from the ones that file is compiled under — and a
  // guard running on the wrong options answers a question nobody asked.
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  // Diagnostics were ignored before, which is how incomplete options went unnoticed.
  expect(
    parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')),
    `${configName} did not parse cleanly`,
  ).toEqual([]);
  return parsed.options;
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** Every specifier a module names, in each of the three spellings that resolve. */
function specifiersOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      found.push((node.arguments[0] as ts.StringLiteralLike).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the shared product', () => {
  it('is reading its own sources', () => {
    // An empty walk would satisfy every assertion below.
    expect(sourceFiles(join(PKG, 'src')).length).toBeGreaterThan(10);
  });

  it('resolves nothing into an application', () => {
    const host = ts.sys;
    const offenders: string[] = [];

    for (const project of PROJECTS) {
      const options = optionsFor(project);
      const root = project.startsWith('src/ui') ? join(PKG, 'src/ui') : join(PKG, 'src');

      for (const file of sourceFiles(root)) {
        // The Node-facing config owns everything outside `src/ui`; skip the
        // overlap rather than reporting each file twice.
        if (project === 'tsconfig.json' && file.startsWith(join(PKG, 'src/ui'))) continue;

        for (const specifier of specifiersOf(file)) {
          const resolved = ts.resolveModuleName(specifier, file, options, host).resolvedModule;
          if (resolved === undefined) {
            // Silence here is the failure mode. `@/…` is an application's alias and
            // resolves under no project in this package, so a file carrying one out
            // of `apps/` — the mistake a move actually makes — resolved to nothing
            // and was skipped by the check below. A relative specifier resolving to
            // nothing is broken on its own terms.
            // A stylesheet or other asset never resolves through the compiler, so ask
            // the filesystem — one left behind by a move still has to fail here. Only
            // a relative one: a package's own asset (`@xyflow/react/dist/style.css`)
            // has no path on this side of the boundary and is the bundler's business.
            if (/\.(css|svg|png|jpe?g|webp|woff2?)$/.test(specifier) && specifier.startsWith('.')) {
              if (!existsSync(resolve(dirname(file), specifier))) {
                offenders.push(
                  `${relative(REPO, file)} -> ${specifier} (no such file) [${project}]`,
                );
              }
              continue;
            }
            if (specifier.startsWith('@/') || specifier.startsWith('.')) {
              offenders.push(
                `${relative(REPO, file)} -> ${specifier} (resolves to nothing) [${project}]`,
              );
            }
            continue;
          }
          const target = resolved.resolvedFileName;
          if (target.includes('/node_modules/')) continue;
          if (!target.startsWith(join(REPO, 'apps') + '/')) continue;
          offenders.push(
            `${relative(REPO, file)} -> ${specifier} (${relative(REPO, target)}) [${project}]`,
          );
        }
      }
    }

    expect(offenders.sort()).toEqual([]);
  });
});
