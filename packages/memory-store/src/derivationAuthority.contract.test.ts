import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src → memory-store → packages → repo root
const REPO_ROOT = join(__dirname, '../../..');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '__tests__', 'coverage']);

function walkSrcTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walkSrcTsFiles(join(dir, entry.name)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function allSrcFiles(): { file: string; rel: string; src: string }[] {
  const roots = [join(REPO_ROOT, 'packages'), join(REPO_ROOT, 'apps')];
  const out: { file: string; rel: string; src: string }[] = [];
  for (const root of roots) {
    for (const file of walkSrcTsFiles(root)) {
      out.push({ file, rel: relative(REPO_ROOT, file), src: readFileSync(file, 'utf8') });
    }
  }
  return out;
}

// ============================================================================
// Part 1 — the link-rebuild write is reachable ONLY through the authority.
//
// `replaceLinksForDoc` mutates the link graph for a doc. Every write that
// rebuilds a doc's links MUST go through commitDerivedIndexes so the rebuild
// binds to the same transaction as the doc put. The only legal callers are the
// repository that defines it and the derivation authority that consumes it.
// ============================================================================

const LINK_WRITE_ALLOWLIST = new Set([
  // Declares the method.
  'packages/database/src/repositories/memoryLinks.ts',
  // The sole caller — inside commitDerivedIndexes, bound to the doc-put tx.
  'packages/memory-store/src/derivation.ts',
]);

// ============================================================================
// Part 2 — the frontmatter/link parsers are reachable only from the authority,
// their own definition modules, the barrel re-export, and the /index.md
// projection (which reads existing docs, never writes a link source).
// ============================================================================

const PARSER_ALLOWLIST = new Set([
  'packages/memory-store/src/links.ts', // defines parseWikilinks
  'packages/memory-store/src/frontmatter.ts', // defines parseFrontmatter
  'packages/memory-store/src/derivation.ts', // the write-path authority
  'packages/memory-store/src/indexNote.ts', // /index.md projection (read-only reuse)
  'packages/memory-store/src/index.ts', // barrel re-export
]);

// ============================================================================
// Part 3 — every file that calls `.put(` on a memory-doc repository must either
// be the derivation authority or an ALLOWLISTED structural writer.
//
// Structural writers address docs by EXACT path with docType json/workflow/
// skill_* — they are never searched and never act as link sources, so they do
// not derive links/properties. Database-internal writers additionally cannot
// route through a memory-store write lane without a package cycle
// (@aflow/memory-store → @aflow/database), so the allowlist — not a forced
// single funnel — is the enforcement.
//
// A NEW writer of LINKABLE content (markdown/text/prompt/…) must go through
// writeMemoryDoc / writeStructuralDoc instead of a bare repo.put, or this test
// fails until it is justified here.
// ============================================================================

const DOC_PUT_ALLOWLIST = new Map<string, string>([
  // --- Derivation authority + the sanctioned inline linkable path ---
  [
    'packages/memory-store/src/writeDoc.ts',
    'the derivation authority (writeMemoryDoc / writeStructuralDoc)',
  ],
  [
    'apps/aflow-executor-memory/src/handlers/memory/handlers/patch.ts',
    'sanctioned inline linkable path — pairs the put with commitDerivedIndexes in the same tx',
  ],
  [
    'packages/server-runtime/src/routes/memory.ts',
    'REST write route — delegates to writeMemoryDoc; the app.put route schema carries the doc shape',
  ],

  // --- Structural writers (exact-path json/workflow/skill_*, not link sources) ---
  [
    'packages/database/src/repositories/appletInstances.ts',
    'database-internal applet state snapshot ({state} wrapper at the reserved exact path ' +
      '/applets/<instanceId>.json, embedding force-disabled, hidden from browse) — the applet ' +
      'gateway is the single writer and the doc is never a link source; cycle-exempt',
  ],
  [
    'packages/database/src/repositories/workflowPaths.ts',
    'database-internal structural workflow/ledger writer — cycle-exempt',
  ],
  [
    'apps/aflow-orchestrator/src/services/cybernetic/evalBatch/fixtureSpaces.ts',
    'eval-fixture replay inputs materialized into a throwaway trial space, written ' +
      'indexing:disabled — promotion mines only exact-path memory.store.get reads and records ' +
      'every other read kind as a fixture gap, so no fixture doc is ever searched or acts as a ' +
      'link source; a partial link graph over a partially materialized space would mislead',
  ],
  [
    'packages/cybernetic-runtime/src/skillSurfacePatch.ts',
    'structural skill projection / workflow.json, exact-path',
  ],
  [
    'packages/cybernetic-runtime/src/skillLifecycle.ts',
    'structural skill projection / workflow.json, exact-path',
  ],
  ['packages/cybernetic-runtime/src/skill.ts', 'structural skill / workflow serialize, exact-path'],
  [
    'packages/cybernetic-runtime/src/coachReviewContext.ts',
    'structural json coach context, exact-path',
  ],
  [
    'packages/cybernetic-runtime/src/digest/persistObservation.ts',
    'structural json observation digest, exact-path',
  ],
  ['packages/cybernetic-runtime/src/facts/persistFacts.ts', 'structural json facts, exact-path'],
  [
    'packages/cybernetic-runtime/src/stagedChange/applyRatifiedOps.ts',
    'structural skill/workflow ratification writer, exact-path',
  ],
  [
    'packages/cybernetic-runtime/src/stagedChange/bundleInstallContent.ts',
    'sanctioned inline linkable path — pairs the seed put with commitDerivedIndexes in the same tx (structural seeds stay indexing:disabled)',
  ],
  [
    'packages/cybernetic-runtime/src/stagedChange/persistRatificationError.ts',
    'structural json ratification error, exact-path',
  ],
  [
    'packages/cybernetic-runtime/src/stagedChange/proactiveStalenessSweep.ts',
    'structural skill projection sweep, exact-path',
  ],
  [
    'packages/cybernetic-runtime/src/stagedChange/skillCatalogUpdate.ts',
    'structural skill catalog, exact-path',
  ],
  [
    'packages/cybernetic-runtime/src/stagedChange/skillComposeApply.ts',
    'structural skill compose, exact-path',
  ],
  [
    'packages/server-runtime/src/services/cybernetic/proposalResolution.ts',
    'structural json proposal resolution, exact-path',
  ],
  [
    'packages/server-runtime/src/services/operatorEvalWrite.ts',
    'structural json eval suite, exact-path',
  ],
  [
    'packages/server-runtime/src/services/operatorSkillCreate.ts',
    'structural skill create, exact-path',
  ],
  [
    'packages/server-runtime/src/routes/cybernetic/anomalies.ts',
    'structural json anomaly record, exact-path',
  ],
  [
    'apps/aflow-executor-api/src/handlers/api/sourceEvidence.ts',
    'structural json source evidence, exact-path',
  ],
  [
    'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/inlineOps/storeListing.ts',
    'structural store listing json, exact-path',
  ],
  [
    'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/inlineOps/workflowCrud/shared.ts',
    'structural workflow.json writer, exact-path',
  ],
  [
    'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/inlineOps/capabilityBinding.ts',
    'structural capability-binding json, exact-path',
  ],
  [
    'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/inlineOps/coachCrudMemory.ts',
    'structural coach json memory (always JSON.stringify, indexing disabled), exact-path',
  ],
  [
    'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/inlineOps/skillCompose.ts',
    'structural skill compose json, exact-path',
  ],
  [
    'packages/cybernetic-runtime/src/taskDraftStore.ts',
    'structural task-draft json (JSON.stringify envelope, indexing disabled), exact-path derived from the run scope — scratch that never enters the link graph and is deleted with the attempt',
  ],
  [
    'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/inlineOps/evalCasePropose.ts',
    'structural staged-change json (JSON.stringify, indexing disabled), exact-path — the same shape and directory skillCompose writes',
  ],
  [
    'packages/server-runtime/src/routes/workflows/mutations.ts',
    'structural workflow.json writer via createWorkflowRepo factory, exact-path',
  ],
]);

// A memory-doc write is any `<receiver>.put(` whose params literal carries the
// memory-doc shape (`docType:` + `path:`). The receiver name is irrelevant — a
// renamed local (`store.put`, `mdRepo.put`, …) or a factory-obtained repo whose
// type token lives in a helper file (createWorkflowRepo) is still caught. The
// old two-gate `(name ∈ fixed set) && (type token in same file)` form missed
// both cases, letting a linkable-content writer bypass the authority silently.
const DOC_REF = /MemoryDocRepository|createMemoryDocRepository|MemoryDocPutParams/;
const NAMED_REPO_PUT = /\b(?:docRepo|repo|txRepo|memoryDocRepo)\.put\(/;

/**
 * True when `src` contains a `.put(` call whose argument (inline literal or a
 * locally-assigned putParams variable) carries the memory-doc shape. Scans a
 * forward window from each `.put(` for `docType:` + `path:`, and — for a
 * variable argument — a preceding `const <var> … docType:` assignment.
 */
function putsMemoryDocShape(src: string): boolean {
  const putRe = /\.put\(\s*([A-Za-z_$][\w$]*)?/g;
  let m: RegExpExecArray | null;
  while ((m = putRe.exec(src)) !== null) {
    const ahead = src.slice(m.index, m.index + 900);
    if (/\bdocType\s*:/.test(ahead) && /\bpath\s*:/.test(ahead)) return true;
    const argVar = m[1];
    if (argVar) {
      const before = src.slice(Math.max(0, m.index - 1500), m.index);
      const assign = new RegExp(`(?:const|let)\\s+${argVar}\\b[\\s\\S]{0,1200}?docType\\s*:`);
      if (assign.test(before)) return true;
    }
  }
  return false;
}

/** A file is a memory-doc writer if it puts a memory-doc-shaped payload OR uses
 * the repo type token alongside a named-repo `.put(`. The union can only ADD
 * callers over either signal alone, so the allowlist stays the single source of
 * truth for what may bypass the derivation authority. */
function writesMemoryDoc(src: string): boolean {
  return putsMemoryDocShape(src) || (DOC_REF.test(src) && NAMED_REPO_PUT.test(src));
}

function importsSymbol(src: string, symbol: string): boolean {
  const importStmt = /\bimport\b[^;]*?\{([^}]*)\}[^;]*?from\s*['"][^'"]+['"]/gs;
  for (const m of src.matchAll(importStmt)) {
    const named = m[1] ?? '';
    if (new RegExp(`\\b${symbol}\\b`).test(named)) return true;
  }
  return false;
}

describe('Plan 249 P1b — derivation authority guard', () => {
  const files = allSrcFiles();

  it('replaceLinksForDoc is called only through the derivation authority', () => {
    const offenders: string[] = [];
    for (const { rel, src } of files) {
      if (LINK_WRITE_ALLOWLIST.has(rel)) continue;
      if (/\breplaceLinksForDoc\b/.test(src)) offenders.push(rel);
    }
    expect(
      offenders,
      'These files reference replaceLinksForDoc directly. The link rebuild must ' +
        'run inside commitDerivedIndexes (bound to the doc-put transaction).',
    ).toEqual([]);
  });

  it('parseWikilinks / parseFrontmatter are imported only by sanctioned modules', () => {
    const offenders: string[] = [];
    for (const { rel, src } of files) {
      if (PARSER_ALLOWLIST.has(rel)) continue;
      if (importsSymbol(src, 'parseWikilinks') || importsSymbol(src, 'parseFrontmatter')) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      'These files import the link/frontmatter parsers directly. Derive through ' +
        'prepareDerivedIndexes (write path) or reuse via the indexNote projection.',
    ).toEqual([]);
  });

  it('every memory-doc repo.put caller is the authority or an allowlisted structural writer', () => {
    const offenders: string[] = [];
    for (const { rel, src } of files) {
      if (!writesMemoryDoc(src)) continue;
      if (DOC_PUT_ALLOWLIST.has(rel)) continue;
      offenders.push(rel);
    }
    expect(
      offenders,
      'These files put a memory-doc-shaped payload without going through ' +
        'writeMemoryDoc / writeStructuralDoc. Route linkable content through the ' +
        'derivation authority, or add a justified allowlist entry (structural JSON / ' +
        'exact-path-addressed / database-internal cycle-exempt).',
    ).toEqual([]);
  });

  it('the allowlist has no stale entries (every listed file still puts a memory doc)', () => {
    const seen = new Map(files.map((f) => [f.rel, f.src]));
    const stale: string[] = [];
    for (const rel of DOC_PUT_ALLOWLIST.keys()) {
      const src = seen.get(rel);
      if (src === undefined || !writesMemoryDoc(src)) stale.push(rel);
    }
    expect(
      stale,
      'Remove these stale allowlist entries — they no longer put a memory doc.',
    ).toEqual([]);
  });

  it('the REST route and workspace flush write through writeMemoryDoc (not a bare put)', () => {
    // The two closed bypasses. A regression reverting either to a bare repo.put
    // would drop link/property derivation for linkable content it flushes.
    const routed = [
      'packages/server-runtime/src/routes/memory.ts',
      'apps/aflow-executor-compute/src/handlers/workspaceManager.ts',
    ];
    const byRel = new Map(files.map((f) => [f.rel, f.src]));
    for (const rel of routed) {
      const src = byRel.get(rel);
      expect(src, `${rel} missing from scan`).toBeTypeOf('string');
      expect(src, `${rel} must invoke writeMemoryDoc`).toMatch(/\bwriteMemoryDoc\s*\(/);
    }
    // workspaceManager is NOT on the allowlist — a bare memory-doc put there
    // would surface as a guard offender, proving the routing is load-bearing.
    expect(
      DOC_PUT_ALLOWLIST.has('apps/aflow-executor-compute/src/handlers/workspaceManager.ts'),
    ).toBe(false);
  });

  it('detects a bypass through a renamed receiver AND a factory-obtained repo', () => {
    // A renamed local variable (`mdStore`) — the old fixed name set would miss it.
    const renamedReceiver = `
      const mdStore = createMemoryDocRepository(db, ctx);
      await mdStore.put({ path: '/notes/hi.md', docType: 'markdown', inlineContent: '[[/x]]' });
    `;
    // A factory-obtained repo whose type token lives elsewhere (createWorkflowRepo)
    // — the old same-file REF-token gate would miss it.
    const factoryReceiver = `
      const repo = createWorkflowRepo(fastify, tenantId);
      await repo.put({ path: '/notes/hi.md', docType: 'markdown', inlineContent: '[[/x]]' });
    `;
    // putParams built as a variable far from the call — shape via var-assignment.
    const variableParams = `
      const putParams = { path: '/notes/hi.md', docType: 'markdown', inlineContent: 'x' };
      await someRepo.put(putParams);
    `;
    expect(writesMemoryDoc(renamedReceiver)).toBe(true);
    expect(writesMemoryDoc(factoryReceiver)).toBe(true);
    expect(writesMemoryDoc(variableParams)).toBe(true);

    // A non-memory .put (Map/cache) with no docType shape must NOT be flagged.
    const unrelatedPut = `cache.put(key, value); myMap.put('k', { size: 1 });`;
    expect(writesMemoryDoc(unrelatedPut)).toBe(false);
  });
});
