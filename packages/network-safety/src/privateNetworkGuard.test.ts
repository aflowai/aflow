/**
 * Plan 336 D3: whether to connect to a private address is decided in one
 * function, `resolveAndValidateHost`, from the policy a caller passes.
 *
 * The rejected design is a wrapper that catches a `private-rfc1918` refusal
 * and connects anyway. It reads as reasonable code where it sits, so the rule
 * is checked by shape: no module outside this package calls `isPrivateIp` or
 * compares a `rangeLabel`. Logging a label stays allowed.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const SEARCH_ROOTS = ['apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.next-dev', 'coverage', '.claude']);
const OWNER = 'packages/network-safety/';

const RANGE_LABEL = String.raw`[\w.?!\]\[]*rangeLabel\b`;

const DECISION_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bisPrivateIp\b/, 'reads isPrivateIp'],
  [new RegExp(String.raw`rangeLabel\b\s*[!=]==?`), 'compares a rangeLabel'],
  [new RegExp(String.raw`[!=]==?\s*${RANGE_LABEL}`), 'compares a rangeLabel'],
  [new RegExp(String.raw`switch\s*\(\s*${RANGE_LABEL}`), 'switches on a rangeLabel'],
  [new RegExp(String.raw`\.(?:includes|has)\(\s*${RANGE_LABEL}`), 'looks up a rangeLabel'],
];

function* sourceFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
    } else if (/\.tsx?$/.test(entry) && !entry.includes('.test.')) {
      yield full;
    }
  }
}

function offendersIn(rel: string, text: string): string[] {
  const found: string[] = [];
  for (const line of text.split('\n')) {
    for (const [pattern, why] of DECISION_PATTERNS) {
      if (pattern.test(line)) found.push(`${rel} ${why}: ${line.trim()}`);
    }
  }
  return found;
}

describe('the private network decision has one owner', () => {
  it('no module outside @aflow/network-safety decides on a range', () => {
    const offenders: string[] = [];
    for (const root of SEARCH_ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file);
        if (rel.startsWith(OWNER)) continue;
        offenders.push(...offendersIn(rel, readFileSync(file, 'utf8')));
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * D1: these destinations are chosen by a run or a provider, never fixed by
   * the operator, so they keep the default policy. A policy reaching one of
   * them is the widening D1 refuses.
   */
  it('keeps the default policy at every agent-chosen and non-MCP caller', () => {
    const defaultCallers = [
      'apps/aflow-executor-api/src/handlers/api/execution.ts',
      'apps/aflow-executor-api/src/handlers/api/oauth2.ts',
      'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/inlineOps/apiAdminOpenApiImport.ts',
      'packages/ai-client/src/providers/runware.ts',
      'packages/ai-client/src/providers/googleVideo.ts',
      'apps/aflow-executor-mcp/src/handlers/tenantPolicyGuard.ts',
      'packages/server-runtime/src/routes/integrations/api-oauth.ts',
    ];
    const policyWords =
      /privateNetwork|PrivateNetworkPolicy|safeFetchFor|privateNetworkPolicyFor|mcpPrivateNetworkPolicy/;
    for (const rel of defaultCallers) {
      expect(readFileSync(join(REPO_ROOT, rel), 'utf8'), rel).not.toMatch(policyWords);
    }
  });

  it('builds a policy from a stored record in one place', () => {
    const builders: string[] = [];
    for (const root of SEARCH_ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file);
        if (rel.startsWith(OWNER)) continue;
        if (/\bprivateNetworkPolicyFor\s*\(/.test(readFileSync(file, 'utf8'))) builders.push(rel);
      }
    }
    expect(builders).toEqual(['packages/oauth/src/mcpBinding.ts']);
  });

  it('catches the shapes it names and lets a logged label through', () => {
    expect(
      offendersIn('x.ts', `if (err.rangeLabel === 'private-rfc1918') connect();`),
    ).toHaveLength(1);
    expect(
      offendersIn('x.ts', `if ('private-rfc1918' !== error?.rangeLabel) return;`),
    ).toHaveLength(1);
    expect(offendersIn('x.ts', 'switch (err.rangeLabel) {')).toHaveLength(1);
    expect(offendersIn('x.ts', 'if (LIFTED.has(err.rangeLabel)) retry();')).toHaveLength(1);
    expect(offendersIn('x.ts', `const { blocked } = isPrivateIp(ip);`)).toHaveLength(1);
    expect(offendersIn('x.ts', 'ctx.log.error({ range: error.rangeLabel });')).toEqual([]);
  });
});
