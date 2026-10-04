/**
 * Which tests can observe a change: those whose imports reach a file it
 * touched, and those naming one by its path. `scripts/verify-commit.mjs` runs
 * these rather than every test of every workspace that reads a touched package.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

const MODULE_FILE = /\.[cm]?[jt]sx?$/;
/** What `vitest.config.ts` resolves workspace packages under, so a test runs their source. */
const SOURCE_CONDITION = 'ts-source';
/** The test sources `testsNaming` reads for a touched file's path. */
const NAMING_TEST_SOURCE = /\.(?:mjs|ts)$/;
/** A character that continues a path, so a match beside one is part of a longer path. */
const PATH_CHARACTER = /[\w./-]/;

/**
 * What one module does with the modules it imports, read from its syntax: the
 * names it declares, the names it passes on from another module, the modules
 * it passes on whole by `export *`, and what it takes from each module it
 * imports — some names, or the whole module.
 */
function readModule(fileName, text) {
  const declared = new Set();
  const passedOn = new Map();
  const starFrom = [];
  const takes = [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest);
  const bind = (name) => {
    if (ts.isIdentifier(name)) declared.add(name.text);
    else
      for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name);
  };
  const hasModifier = (node, kind) =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause === undefined) {
        takes.push({ specifier, names: null });
        continue;
      }
      if (clause.isTypeOnly) continue;
      const bindings = clause.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        takes.push({ specifier, names: null });
        continue;
      }
      const names = [
        ...(clause.name !== undefined ? ['default'] : []),
        ...(bindings?.elements ?? [])
          .filter((element) => !element.isTypeOnly)
          .map((element) => (element.propertyName ?? element.name).text),
      ];
      if (names.length > 0) takes.push({ specifier, names });
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (statement.moduleSpecifier === undefined) {
        for (const element of clause?.elements ?? []) {
          if (!element.isTypeOnly) declared.add(element.name.text);
        }
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      if (clause === undefined) starFrom.push(specifier);
      else if (ts.isNamespaceExport(clause)) {
        passedOn.set(clause.name.text, { specifier, name: null });
      } else {
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;
          const name = (element.propertyName ?? element.name).text;
          passedOn.set(element.name.text, { specifier, name });
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      declared.add('default');
    } else if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) declared.add('default');
      else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) bind(declaration.name);
      } else if (statement.name !== undefined) declared.add(statement.name.text);
    }
  }
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      takes.push({ specifier: node.arguments[0].text, names: null });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      takes.push({ specifier: node.moduleReference.expression.text, names: null });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { declared, passedOn, starFrom, takes };
}

/**
 * The tests among `candidates` whose import closure includes one of `files`.
 * Every path is relative to `repository`, the first two segments of one naming its
 * workspace; `packageDirOf` names the workspace directory a package
 * specifier belongs to, and `textAtBase` reads a file as it stood before the
 * change, or nothing where the change added it.
 *
 * The closure is followed by name: an import of some names leads to the module
 * that declares each of them — through every re-export on the way, so a
 * package's index stands only for what is taken from it — and on through that
 * module's own imports. A namespace, side-effect, dynamic or `require` import
 * takes the whole module, re-exports and all; a type-only one executes nothing
 * and is not followed.
 *
 * Each specifier is resolved as TypeScript resolves it under the importing
 * workspace's own config, with the condition the tests run under, so a
 * workspace package's import lands on the source a test executes and a path alias on
 * the file it names. An import that resolves to nothing still names a path,
 * which is how a test meets a file the change deleted; one to a package that
 * resolves only to its build stands for the whole package.
 */
export function testsReaching({ repository, files, candidates, textAtBase, packageDirOf }) {
  const root = realpathSync(repository);
  const withoutExtension = (file) => file.replace(MODULE_FILE, '');
  const workspaceDir = (file) => file.split('/').slice(0, 2).join('/');
  const packageNode = (dir) => `${dir}/`;
  const targets = new Set([
    ...files,
    ...files.filter((file) => !existsSync(path.join(root, file))).map(withoutExtension),
    ...files.map((file) => packageNode(workspaceDir(file))),
  ]);

  const resolvers = new Map();
  const resolverFor = (dir) => {
    let resolver = resolvers.get(dir);
    if (resolver === undefined) {
      const config = path.join(root, dir, 'tsconfig.json');
      const parsed = existsSync(config)
        ? ts.getParsedCommandLineOfConfigFile(
            config,
            {},
            { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
          )
        : undefined;
      const options = {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        ...parsed?.options,
        customConditions: [SOURCE_CONDITION],
      };
      resolver = { options, cache: ts.createModuleResolutionCache(root, (name) => name, options) };
      resolvers.set(dir, resolver);
    }
    return resolver;
  };
  const resolve = (specifier, file) => {
    const { options, cache } = resolverFor(workspaceDir(file));
    const resolved = ts.resolveModuleName(specifier, path.join(root, file), options, ts.sys, cache);
    const resolvedFile = resolved.resolvedModule?.resolvedFileName;
    const packageDir = packageDirOf(specifier);
    let target;
    if (resolvedFile !== undefined && !resolvedFile.endsWith('.d.ts')) {
      target = path.relative(root, realpathSync(resolvedFile)).split(path.sep).join('/');
    } else if (packageDir !== undefined) {
      target = packageNode(packageDir);
    } else if (resolvedFile === undefined && specifier.startsWith('.')) {
      target = withoutExtension(path.posix.join(path.posix.dirname(file), specifier));
    }
    if (target === undefined || target.startsWith('..')) return undefined;
    return target.split('/').includes('node_modules') ? undefined : target;
  };

  const modules = new Map();
  const moduleOf = (file) => {
    let module = modules.get(file);
    if (module === undefined) {
      const absolute = path.join(root, file);
      module =
        MODULE_FILE.test(file) && existsSync(absolute)
          ? { parsed: true, ...readModule(absolute, readFileSync(absolute, 'utf8')) }
          : { parsed: false, declared: new Set(), passedOn: new Map(), starFrom: [], takes: [] };
      modules.set(file, module);
    }
    return module;
  };

  // A node is a module run for its own code, one name taken from it, or the
  // whole of it; each leads to what it executes or passes the name on to.
  const body = (file) => `body\0${file}`;
  const named = (file, name) => `name\0${file}\0${name}`;
  const whole = (file) => `whole\0${file}`;
  const successors = (node) => {
    const [kind, file, name] = node.split('\0');
    const module = moduleOf(file);
    const next = [];
    const take = (specifier, names) => {
      const target = resolve(specifier, file);
      if (target === undefined) return;
      if (names === null) next.push(whole(target));
      else next.push(...names.map((taken) => named(target, taken)));
    };
    if (kind === 'body') {
      for (const { specifier, names } of module.takes) take(specifier, names);
    } else if (kind === 'whole') {
      next.push(body(file));
      for (const passed of module.passedOn.values()) {
        take(passed.specifier, passed.name === null ? null : [passed.name]);
      }
      for (const specifier of module.starFrom) take(specifier, null);
    } else if (module.declared.has(name)) {
      next.push(body(file));
    } else if (module.passedOn.has(name)) {
      const passed = module.passedOn.get(name);
      take(passed.specifier, passed.name === null ? null : [passed.name]);
    } else {
      for (const specifier of module.starFrom) take(specifier, [name]);
    }
    return next;
  };

  const importers = new Map();
  const seen = new Set();
  const pending = candidates.map(body);
  while (pending.length > 0) {
    const node = pending.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of successors(node)) {
      if (!importers.has(next)) importers.set(next, []);
      importers.get(next).push(node);
      pending.push(next);
    }
  }
  // A name looked for through `export *` is looked for in every module the
  // index passes on, and only the one that has it is reached. A touched index
  // that passes a name on reaches it only where the change moved where that
  // name comes from: adding an export to an index changes no other export.
  const passedOnBefore = new Map();
  const passedOnAtBase = (file) => {
    if (!passedOnBefore.has(file)) {
      const text = textAtBase(file);
      passedOnBefore.set(file, text === undefined ? new Map() : readModule(file, text).passedOn);
    }
    return passedOnBefore.get(file);
  };
  const reachesTarget = (node) => {
    const [kind, file, name] = node.split('\0');
    if (!targets.has(file)) return false;
    const module = modules.get(file);
    if (kind !== 'name' || !module.parsed || module.declared.has(name)) return true;
    if (!module.passedOn.has(name)) return false;
    const before = passedOnAtBase(file).get(name);
    return JSON.stringify(module.passedOn.get(name)) !== JSON.stringify(before);
  };
  const reaches = new Set([...seen].filter(reachesTarget));
  const frontier = [...reaches];
  while (frontier.length > 0) {
    for (const importer of importers.get(frontier.pop()) ?? []) {
      if (reaches.has(importer)) continue;
      reaches.add(importer);
      frontier.push(importer);
    }
  }
  return [...new Set(candidates)].filter((file) => reaches.has(body(file)));
}

/**
 * The tests among `candidates` naming one of `files` by its repository path in
 * a string literal — a test that runs a script by path imports nothing from it,
 * so `testsReaching` never selects it. Only `.mjs` and `.ts` tests are read,
 * and a path counts only whole: `scripts/verify-commit.mjs` names that file,
 * `verify-commit` and `other/scripts/verify-commit.mjs` do not.
 */
export function testsNaming({ repository, files, candidates }) {
  const root = realpathSync(repository);
  const namesFile = (literal) =>
    files.some((file) => {
      for (let at = literal.indexOf(file); at !== -1; at = literal.indexOf(file, at + 1)) {
        const before = literal[at - 1];
        const after = literal[at + file.length];
        if (
          (before === undefined || !PATH_CHARACTER.test(before)) &&
          (after === undefined || !PATH_CHARACTER.test(after))
        ) {
          return true;
        }
      }
      return false;
    });
  const named = (file) => {
    const source = ts.createSourceFile(
      file,
      readFileSync(path.join(root, file), 'utf8'),
      ts.ScriptTarget.Latest,
    );
    const visit = (node) =>
      ((ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) && namesFile(node.text)) ||
      (ts.forEachChild(node, visit) ?? false);
    return visit(source);
  };
  return [...new Set(candidates)].filter(
    (file) => NAMING_TEST_SOURCE.test(file) && existsSync(path.join(root, file)) && named(file),
  );
}

/**
 * The repository-shape guards a change answers to. They read the repository's
 * own files — `.mcp.json`, a root dot-file, a workflow under `.github` — which
 * no import reaches, so `testsReaching` never selects them; every one of them
 * runs when a touched file lies outside every workspace, and `outside` names
 * the files that called them.
 */
export function repositoryShapeGuards({ files, workspaceDirs, guards }) {
  const outside = files.filter((file) => !workspaceDirs.has(file.split('/').slice(0, 2).join('/')));
  return { outside, guards: outside.length === 0 ? [] : [...guards] };
}
