/**
 * Contract: every payload store of a durable kind passes `persist: true`.
 *
 * The Redis store gives a payload stored without `persist` its default TTL, and
 * nothing fails at the write: a durable payload that expires fails whichever
 * read first follows the TTL, days later and far from the writer that forgot.
 *
 * A call whose kind is not a string literal cannot be judged here, so it must
 * name `persist` itself — derived with `isDurablePayloadKind` where the kind
 * varies. A call whose argument is not an object literal cannot be read at all
 * and is refused for the same reason.
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

interface StoreCall {
  site: string;
  kind: { literal: string } | 'computed' | 'absent';
  persist: 'true' | 'other' | 'absent';
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

function storeCalls(file: string, source = readFileSync(file, 'utf-8')): StoreCall[] {
  if (!/\.store(?:Bytes)?(?:ContentAddressed)?\s*\(/.test(source)) return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
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
        calls.push({
          site,
          kind:
            kind === undefined
              ? 'absent'
              : ts.isPropertyAssignment(kind) && ts.isStringLiteralLike(kind.initializer)
                ? { literal: kind.initializer.text }
                : 'computed',
          persist:
            persist === undefined
              ? 'absent'
              : ts.isPropertyAssignment(persist) &&
                  persist.initializer.kind === ts.SyntaxKind.TrueKeyword
                ? 'true'
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
    return call.persist === 'absent'
      ? `${call.site}: the kind is computed, so name persist — isDurablePayloadKind(kind)`
      : undefined;
  }
  if (DURABLE.has(call.kind.literal) && call.persist !== 'true') {
    return `${call.site}: '${call.kind.literal}' is a durable kind — pass persist: true`;
  }
  return undefined;
}

describe('durable payload kinds', () => {
  const calls = productionSourceFiles(REPO_ROOT).flatMap((file) => storeCalls(file));

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
    expect(storeCalls(fixture, source).map(offence)).toEqual([
      "fixture.ts:1: 'history' is a durable kind — pass persist: true",
      "fixture.ts:2: 'state' is a durable kind — pass persist: true",
      'fixture.ts:3: the kind is computed, so name persist — isDurablePayloadKind(kind)',
      'fixture.ts:4: pass the store an object literal, so its kind and persist can be read',
      'fixture.ts:5: name the kind in the literal, not in a spread',
      undefined,
    ]);
  });

  it('are stored with persist: true by every writer', () => {
    expect(calls.map(offence).filter((found) => found !== undefined)).toEqual([]);
  });
});
