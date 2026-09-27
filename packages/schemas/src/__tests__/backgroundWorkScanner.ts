/**
 * Static inventory of production background work.
 *
 * Regex alone cannot see the two most common shapes of a recurring worker in
 * this codebase — a `setTimeout` that re-arms itself from inside the function it
 * schedules, and a blocking stream consumer — so those are found with the
 * TypeScript AST. Everything else is a textual pattern matched against the whole
 * file with comments blanked, because Prettier wraps a call away from its
 * argument and a per-line regex stops matching when it does.
 *
 * Not a `.test.ts` file: it is the shared scanner, imported by the contract
 * test and by the inventory script.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

export const DISCOVERY_RULES = [
  'setInterval',
  'recursive-timer',
  'blocking-consumer',
  'redis-keys',
  'keyspace-scan',
  'full-set-read',
  'tenant-enumeration',
] as const;

export type DiscoveryRule = (typeof DISCOVERY_RULES)[number];

export interface Finding {
  file: string;
  line: number;
  rule: DiscoveryRule;
}

/**
 * `apps/web` is excluded on purpose: browser animation timers, protocol pings,
 * and request-local timeouts are explicit non-goals. Everything else that runs
 * on a server is in scope — the whole workspace, not just `src`, so a loop
 * parked outside it is still seen.
 */
const EXCLUDED_WORKSPACES = new Set(['web']);
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  '__tests__',
  '__mocks__',
]);

const TEXT_RULES: ReadonlyArray<{ id: DiscoveryRule; pattern: RegExp }> = [
  { id: 'setInterval', pattern: /\bsetInterval\s*\(/g },
  // `Object.keys(x)` and `Reflect.keys(x)` are the only common non-Redis forms
  // that take an argument; `map.keys()` takes none.
  { id: 'redis-keys', pattern: /(?<!Object|Reflect)\.keys\s*\(\s*[^)\s]/g },
  { id: 'keyspace-scan', pattern: /\.scan(?:Stream)?\s*\(/g },
  // `smembers`, and the sorted-set spelling of the same thing. Moving a whole
  // -collection read from one command to the other used to take it out of scope
  // silently, which is the one way a rule like this is lost: not argued away,
  // just no longer matched. A `zrange` over a real range is a bounded read and
  // is deliberately not caught.
  { id: 'full-set-read', pattern: /\.smembers\s*\(|\.zrange\s*\([^)]*?,\s*0\s*,\s*-1\s*\)/g },
  { id: 'tenant-enumeration', pattern: /\blistTenantSchemas\s*\(/g },
  // Matches the member access rather than the call: the one blocking consumer
  // reached through a type cast — `(redis.xreadgroup as ...)(...)` — evaded a
  // pattern anchored on the opening paren, so the read feeding every result
  // ack went unattributed.
  { id: 'blocking-consumer', pattern: /\.xreadgroup\b|\.xread\b/g },
];

function isTestFile(path: string): boolean {
  return (
    /\.(test|spec)\.tsx?$/.test(path) || /\.pg\.test\.tsx?$/.test(path) || path.endsWith('.d.ts')
  );
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !isTestFile(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
}

export function productionSourceFiles(repoRoot: string): string[] {
  const files: string[] = [];
  for (const segment of ['apps', 'packages'] as const) {
    const base = join(repoRoot, segment);
    for (const workspace of readdirSync(base, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      if (EXCLUDED_WORKSPACES.has(workspace.name)) continue;
      walk(join(base, workspace.name), files);
    }
  }
  return files;
}

/** Blank comment bodies while preserving offsets, so line numbers stay true. */
function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, prefix: string) => prefix + ' '.repeat(match.length - prefix.length),
    );
}

/** The name a function-like node is bound to, if any. */
function enclosingFunctionName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      current.parent &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    current = current.parent;
  }
  return undefined;
}

function referencedIdentifiers(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) names.add(child.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
}

/**
 * A `setTimeout` whose callback calls back into the function that scheduled it
 * — the sanctioned way to write a non-overlapping loop, and therefore a
 * recurring worker that must be registered like any other.
 */
function findRecursiveTimers(sourceFile: ts.SourceFile): number[] {
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'setTimeout' &&
      node.arguments.length > 0
    ) {
      const enclosing = enclosingFunctionName(node);
      const callback = node.arguments[0];
      if (enclosing !== undefined && callback && referencedIdentifiers(callback).has(enclosing)) {
        lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

export function scanBackgroundWork(repoRoot: string): Finding[] {
  const findings: Finding[] = [];

  for (const absolute of productionSourceFiles(repoRoot)) {
    const file = relative(repoRoot, absolute).split(sep).join('/');
    const raw = readFileSync(absolute, 'utf8');
    const source = blankComments(raw);

    for (const rule of TEXT_RULES) {
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(source)) !== null) {
        if (
          rule.id === 'tenant-enumeration' &&
          /function\s+listTenantSchemas/.test(
            source.slice(Math.max(0, match.index - 40), match.index + 30),
          )
        ) {
          continue;
        }
        findings.push({
          file,
          line: source.slice(0, match.index).split('\n').length,
          rule: rule.id,
        });
      }
    }

    if (raw.includes('setTimeout')) {
      const sourceFile = ts.createSourceFile(absolute, raw, ts.ScriptTarget.Latest, true);
      for (const line of findRecursiveTimers(sourceFile)) {
        findings.push({ file, line, rule: 'recursive-timer' });
      }
    }
  }

  return findings;
}

/** `file -> rule -> occurrences`, the shape the registry declares. */
export function countByFileAndRule(findings: Finding[]): Map<string, Map<DiscoveryRule, number>> {
  const counts = new Map<string, Map<DiscoveryRule, number>>();
  for (const finding of findings) {
    const perFile = counts.get(finding.file) ?? new Map<DiscoveryRule, number>();
    perFile.set(finding.rule, (perFile.get(finding.rule) ?? 0) + 1);
    counts.set(finding.file, perFile);
  }
  return counts;
}
