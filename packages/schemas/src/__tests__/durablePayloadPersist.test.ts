/**
 * Contract: every payload store of a durable kind passes `persist: true`.
 *
 * The Redis store gives a payload stored without `persist` its default TTL, and
 * nothing fails at the write: a durable payload that expires fails whichever
 * read first follows the TTL, days later and far from the writer that forgot.
 *
 * A call whose kind is not a string literal is judged by the kind's static type:
 * one that admits only non-durable kinds needs no `persist`. Any other — a type
 * that admits a durable kind, or one that cannot be read — must name `persist`
 * itself, derived with `isDurablePayloadKind`; a literal `persist: false` there
 * is refused, since it holds only while the kind stays non-durable. A call whose
 * argument is not an object literal cannot be read at all and is refused for
 * the same reason.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { DURABLE_PAYLOAD_KINDS } from '../runtime/payloadRef.js';
import { productionSourceFiles } from './backgroundWorkScanner.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const STORE_METHODS = new Set([
  'store',
  'storeBytes',
  'storeContentAddressed',
  'storeBytesContentAddressed',
]);

const DURABLE = new Set<string>(DURABLE_PAYLOAD_KINDS);

/**
 * Resolution as the services run: workspace packages from their `ts-source`
 * export, so a kind typed in another package reads without a build.
 */
const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  customConditions: ['ts-source'],
  strict: true,
  exactOptionalPropertyTypes: true,
  skipLibCheck: true,
  esModuleInterop: true,
  resolveJsonModule: true,
  types: ['node'],
  noEmit: true,
};

interface StoreCall {
  site: string;
  kind: { literal: string } | 'computed' | 'absent';
  /** The literals a computed kind's static type admits; absent where it is not a union of them. */
  kindType?: readonly string[];
  persist: 'true' | 'false' | 'other' | 'absent';
  spreads: boolean;
  literalArgument: boolean;
}

function propertyNamed(
  literal: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  return literal.properties.find(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name,
  );
}

function kindTypeOf(
  checker: ts.TypeChecker,
  kind: ts.ObjectLiteralElementLike,
): readonly string[] | undefined {
  let type: ts.Type;
  if (ts.isShorthandPropertyAssignment(kind)) {
    const value = checker.getShorthandAssignmentValueSymbol(kind);
    if (value === undefined) return undefined;
    type = checker.getTypeOfSymbolAtLocation(value, kind);
  } else if (ts.isPropertyAssignment(kind)) {
    type = checker.getTypeAtLocation(kind.initializer);
  } else {
    return undefined;
  }
  const members = type.isUnion() ? type.types : [type];
  const literals = members.filter((member) => member.isStringLiteral());
  return literals.length === members.length ? literals.map((member) => member.value) : undefined;
}

function typedProgram(sources: ReadonlyMap<string, string>): ts.Program {
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (file) => sources.has(file) || fileExists(file);
  host.getSourceFile = (file, languageVersion, ...rest) => {
    const text = sources.get(file);
    return text === undefined
      ? getSourceFile(file, languageVersion, ...rest)
      : ts.createSourceFile(file, text, languageVersion, true);
  };
  return ts.createProgram({ rootNames: [...sources.keys()], options: COMPILER_OPTIONS, host });
}

const STORE_CALL = /\.store(?:Bytes)?(?:ContentAddressed)?\s*\(/;

/**
 * Types are read only for the files that need them — a computed kind with no
 * `persist` — since a program pulls in everything those files import.
 */
function storeCalls(sources: ReadonlyMap<string, string>): StoreCall[] {
  const candidates = [...sources].filter(([, source]) => STORE_CALL.test(source));
  const syntactic = new Map(
    candidates.map(([file, source]) => [
      file,
      scanStoreCalls(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)),
    ]),
  );
  const typed = candidates.filter(([file]) =>
    syntactic.get(file)?.some((call) => call.kind === 'computed' && call.persist === 'absent'),
  );
  if (typed.length === 0) return [...syntactic.values()].flat();
  const program = typedProgram(new Map(typed));
  const checker = program.getTypeChecker();
  return candidates.flatMap(([file]) => {
    const tree = typed.some(([typedFile]) => typedFile === file)
      ? program.getSourceFile(file)
      : undefined;
    return tree === undefined ? (syntactic.get(file) ?? []) : scanStoreCalls(tree, checker);
  });
}

function scanStoreCalls(tree: ts.SourceFile, checker?: ts.TypeChecker): StoreCall[] {
  const file = tree.fileName;
  const calls: StoreCall[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      STORE_METHODS.has(node.expression.name.text) &&
      node.arguments.length === 1
    ) {
      const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
      const site = `${relative(REPO_ROOT, file).split(sep).join('/')}:${line}`;
      const argument = node.arguments[0];
      if (argument === undefined || !ts.isObjectLiteralExpression(argument)) {
        calls.push({
          site,
          kind: 'absent',
          persist: 'absent',
          spreads: false,
          literalArgument: false,
        });
      } else {
        const kind = propertyNamed(argument, 'kind');
        const persist = propertyNamed(argument, 'persist');
        const literal =
          kind !== undefined &&
          ts.isPropertyAssignment(kind) &&
          ts.isStringLiteralLike(kind.initializer)
            ? kind.initializer.text
            : undefined;
        const kindType =
          kind !== undefined && literal === undefined && checker !== undefined
            ? kindTypeOf(checker, kind)
            : undefined;
        const persistValue =
          persist !== undefined && ts.isPropertyAssignment(persist)
            ? persist.initializer.kind
            : undefined;
        calls.push({
          site,
          kind: kind === undefined ? 'absent' : literal !== undefined ? { literal } : 'computed',
          ...(kindType !== undefined ? { kindType } : {}),
          persist:
            persist === undefined
              ? 'absent'
              : persistValue === ts.SyntaxKind.TrueKeyword
                ? 'true'
                : persistValue === ts.SyntaxKind.FalseKeyword
                  ? 'false'
                  : 'other',
          spreads: argument.properties.some(ts.isSpreadAssignment),
          literalArgument: true,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return calls;
}

function offence(call: StoreCall): string | undefined {
  if (!call.literalArgument) {
    return `${call.site}: pass the store an object literal, so its kind and persist can be read`;
  }
  if (call.kind === 'absent') {
    // A `.store({...})` with no kind is some other store's method — unless a
    // spread could be carrying the kind out of sight.
    return call.spreads ? `${call.site}: name the kind in the literal, not in a spread` : undefined;
  }
  if (call.kind === 'computed') {
    if (call.persist === 'false') {
      return `${call.site}: the kind is computed, so persist: false holds only while it stays non-durable — derive it, isDurablePayloadKind(kind)`;
    }
    if (call.persist !== 'absent') return undefined;
    if (call.kindType !== undefined && !call.kindType.some((kind) => DURABLE.has(kind))) {
      return undefined;
    }
    return `${call.site}: the kind is computed and its type does not rule out a durable kind, so name persist — isDurablePayloadKind(kind)`;
  }
  if (DURABLE.has(call.kind.literal) && call.persist !== 'true') {
    return `${call.site}: '${call.kind.literal}' is a durable kind — pass persist: true`;
  }
  return undefined;
}

describe('durable payload kinds', () => {
  const calls = storeCalls(
    new Map(productionSourceFiles(REPO_ROOT).map((file) => [file, readFileSync(file, 'utf-8')])),
  );

  it('finds the stores it judges', () => {
    // An empty sweep would pass vacuously; every durable kind has writers.
    for (const kind of DURABLE_PAYLOAD_KINDS) {
      expect(
        calls.filter((call) => typeof call.kind === 'object' && call.kind.literal === kind).length,
      ).toBeGreaterThan(0);
    }
  });

  it('are refused without persist, whatever shape the omission takes', () => {
    const fixture = join(REPO_ROOT, 'fixture.ts');
    const source = [
      "await payloadStore.store({ kind: 'history', data, persist: false });",
      "await payloadStore.store({ kind: 'state', data });",
      'await payloadStore.store({ kind, data });',
      'await payloadStore.store(params);',
      'await payloadStore.store({ ...params, data });',
      "await payloadStore.store({ kind: 'output', data });",
    ].join('\n');
    expect(storeCalls(new Map([[fixture, source]])).map(offence)).toEqual([
      "fixture.ts:1: 'history' is a durable kind — pass persist: true",
      "fixture.ts:2: 'state' is a durable kind — pass persist: true",
      'fixture.ts:3: the kind is computed and its type does not rule out a durable kind, so name persist — isDurablePayloadKind(kind)',
      'fixture.ts:4: pass the store an object literal, so its kind and persist can be read',
      'fixture.ts:5: name the kind in the literal, not in a spread',
      undefined,
    ]);
  });

  it('judge a computed kind by its static type', () => {
    const fixture = join(REPO_ROOT, 'fixture.ts');
    const source = [
      "declare const blobKind: 'artifact_html' | 'output';",
      "declare const turnKind: 'output' | 'history';",
      'declare const anyKind: string;',
      'declare const payloadStore: { store(params: object): Promise<string> };',
      'await payloadStore.store({ kind: blobKind, data: 1 });',
      'await payloadStore.store({ kind: turnKind, data: 1 });',
      'await payloadStore.store({ kind: anyKind, data: 1 });',
      "const kind = blobKind === 'output' ? ('requested_input' as const) : blobKind;",
      'await payloadStore.store({ kind, data: 1 });',
      'await payloadStore.store({ kind: turnKind, data: 1, persist: false });',
      'await payloadStore.store({ kind: blobKind, data: 1, persist: false });',
      'export {};',
    ].join('\n');
    expect(storeCalls(new Map([[fixture, source]])).map(offence)).toEqual([
      undefined,
      'fixture.ts:6: the kind is computed and its type does not rule out a durable kind, so name persist — isDurablePayloadKind(kind)',
      'fixture.ts:7: the kind is computed and its type does not rule out a durable kind, so name persist — isDurablePayloadKind(kind)',
      undefined,
      'fixture.ts:10: the kind is computed, so persist: false holds only while it stays non-durable — derive it, isDurablePayloadKind(kind)',
      'fixture.ts:11: the kind is computed, so persist: false holds only while it stays non-durable — derive it, isDurablePayloadKind(kind)',
    ]);
  });

  it('are stored with persist: true by every writer', () => {
    expect(calls.map(offence).filter((found) => found !== undefined)).toEqual([]);
  });
});
