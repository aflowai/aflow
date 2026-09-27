/**
 * Three words the product does not say to an operator.
 *
 * `harness` is the coding lane's name in the code; on screen the thing is a
 * coding agent, and where the machine reported which one it installed, that is
 * its name. `Shop` was one rail entry against `Store` everywhere else. `the
 * cybernetic agent` is the platform's own word for its ensemble; the operator
 * talks to Helmsman.
 *
 * Standing rather than one-off, because copy is written continuously and this is
 * the only surface where the vocabulary can be enforced at all — a reviewer sees
 * one string, not the set.
 *
 * Operator-facing strings only, found by parsing: JSX text, and string literals
 * given to the props that put words on screen. Identifiers, keys, operation ids,
 * CSS class names and comments keep their names — they are the lane's vocabulary
 * and it is correct there, which is exactly why a text scan over the whole file
 * would report them and be switched off.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));

/** Props whose value is read by a person rather than by the machine. */
const COPY_PROPS = new Set([
  'label',
  'title',
  'placeholder',
  'description',
  'tagline',
  'aria-label',
]);

const BANNED: ReadonlyArray<{ pattern: RegExp; instead: string }> = [
  { pattern: /\bharness(es)?\b/i, instead: 'coding agent, or the agent’s own label' },
  { pattern: /\bshop\b/i, instead: 'Store' },
  { pattern: /\bcybernetic agent\b/i, instead: 'Helmsman' },
];

/**
 * Strings that read as operator copy and are not.
 *
 * Empty on purpose: every occurrence had a word that says the same thing better.
 * An entry here is an exact string, so an allowance cannot widen past the one
 * case it was written for.
 */
const ALLOWED: ReadonlySet<string> = new Set<string>();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name)) return [];
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

function attributeName(name: ts.JsxAttributeName): string {
  return ts.isIdentifier(name) ? name.text : `${name.namespace.text}:${name.name.text}`;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/** The words a literal puts on screen, or undefined where it puts none. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isJsxExpression(node) && node.expression !== undefined) {
    return literalText(node.expression);
  }
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
  }
  if (ts.isConditionalExpression(node)) {
    // A ternary inside a copy prop is two strings, and both are copy.
    return [literalText(node.whenTrue), literalText(node.whenFalse)]
      .filter((part): part is string => part !== undefined)
      .join(' ');
  }
  return undefined;
}

interface Occurrence {
  file: string;
  line: number;
  text: string;
}

function operatorCopy(file: string): Occurrence[] {
  const code = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Occurrence[] = [];

  const record = (node: ts.Node, text: string | undefined): void => {
    if (text === undefined || text.trim() === '') return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push({ file: relative(UI_ROOT, file), line: line + 1, text });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      record(node, node.text);
    } else if (ts.isJsxAttribute(node) && COPY_PROPS.has(attributeName(node.name))) {
      if (node.initializer !== undefined) record(node, literalText(node.initializer));
    } else if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name !== undefined && COPY_PROPS.has(name)) record(node, literalText(node.initializer));
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return found;
}

const COPY: readonly Occurrence[] = sourceFiles(UI_ROOT).flatMap(operatorCopy);

describe('operator-facing copy in the product package', () => {
  it('has copy to scan at all, so a silent pass cannot be a broken walk', () => {
    // Thousands today; a walk that broke would report a handful, and the
    // vocabulary tests below would pass on an empty set.
    expect(COPY.length).toBeGreaterThan(1_000);
  });

  for (const { pattern, instead } of BANNED) {
    it(`never says ${String(pattern)} — it says ${instead}`, () => {
      const hits = COPY.filter(
        (occurrence) => pattern.test(occurrence.text) && !ALLOWED.has(occurrence.text),
      ).map(({ file, line, text }) => `${file}:${String(line)} — ${text.trim()}`);
      expect(hits, `Say ${instead} instead:\n  ${hits.join('\n  ')}`).toEqual([]);
    });
  }
});
