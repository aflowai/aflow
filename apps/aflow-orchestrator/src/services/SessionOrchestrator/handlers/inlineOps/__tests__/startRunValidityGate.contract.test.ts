import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __tests__ → inlineOps → handlers → SessionOrchestrator → services → src
const ORCH_SRC = join(__dirname, '../../../../..');

/** The public run-start handler, relative to the orchestrator src root. */
const RUN_START_HANDLER =
  'services/SessionOrchestrator/handlers/inlineOps/workflowCrud/run/start.ts';

/**
 * The two legal harness-`startRun` callers: the public run-start handler and
 * the eval-batch revision-pinned launcher (Plan 269 D5 — orchestrator-
 * internal, never agent-exposed). Both must recompute contract validity
 * before dispatch; anything else reaching startRun is an execution-entry
 * leak.
 */
const LEGAL_START_RUN_CALLERS = [
  RUN_START_HANDLER,
  'services/cybernetic/evalBatch/startWorkflowRunAtRevision.ts',
].sort();

const VALIDITY_GATE_SYMBOLS = ['materializeAndValidateSkillConfig', 'ensureCurrentSkillValidity'];

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip the harness implementation itself (it DEFINES startRun) and any
      // test directories.
      if (entry.name === '__tests__' || full.endsWith('/cybernetic/harness')) continue;
      out.push(...walkTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Does this source text invoke the harness `startRun` (first-wave dispatch)?
 * Matches both the dynamic-import destructure used by the run-start handler
 * and any hypothetical static import from the harness barrel. Deliberately
 * does NOT match `dispatchRetriedTask`, `cancelRun`, `completeRun`, etc.
 */
function destructuresHarnessStartRun(src: string): boolean {
  const dynamic =
    /(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*['"][^'"]*WorkflowRunHarness[^'"]*['"]\s*\)/g;
  for (const m of src.matchAll(dynamic)) {
    if (/\bstartRun\b/.test(m[1] ?? '')) return true;
  }
  const staticImport =
    /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]*(?:WorkflowRunHarness|harness\/(?:startRun|index))[^'"]*['"]/g;
  for (const m of src.matchAll(staticImport)) {
    if (/\bstartRun\b/.test(m[1] ?? '')) return true;
  }
  return false;
}

describe('Plan 190 §5.2 — harness startRun execution-entry closure', () => {
  const files = walkTsFiles(ORCH_SRC);

  it('has exactly the two legal production callers of harness startRun', () => {
    const callers = files
      .filter((f) => destructuresHarnessStartRun(readFileSync(f, 'utf8')))
      .map((f) => relative(ORCH_SRC, f))
      .sort();

    expect(callers).toEqual(LEGAL_START_RUN_CALLERS);
  });

  it.each(LEGAL_START_RUN_CALLERS)(
    '%s recomputes contract validity before reaching dispatch',
    (caller) => {
      const callerPath = join(ORCH_SRC, caller);
      expect(statSync(callerPath).isFile()).toBe(true);
      const src = readFileSync(callerPath, 'utf8');

      const gateSymbol = VALIDITY_GATE_SYMBOLS.find((sym) => src.includes(sym));
      expect(
        gateSymbol,
        'every startRun caller must call the Plan 190 validity gate (materializeAndValidateSkillConfig / ensureCurrentSkillValidity)',
      ).toBeDefined();

      // The gate must run BEFORE first-wave dispatch — i.e. the gate symbol's
      // first occurrence precedes the `startRun(` invocation in source order.
      const gateIdx = src.indexOf(gateSymbol!);
      const dispatchIdx = src.search(/\bstartRun\s*\(/);
      expect(dispatchIdx).toBeGreaterThan(-1);
      expect(
        gateIdx,
        'the validity gate must be evaluated before startRun() is invoked',
      ).toBeLessThan(dispatchIdx);
    },
  );

  it('the invalid branch routes diagnostics to the Coach repair trigger (Plan 183g §2.1 seam 1)', () => {
    const handlerPath = join(ORCH_SRC, RUN_START_HANDLER);
    const src = readFileSync(handlerPath, 'utf8');

    // Isolate the gate's invalid branch by brace-matching its block, so the
    // assertions below can't be satisfied by calls elsewhere in the handler.
    const guard = /if\s*\(\s*validity\.status\s*===\s*'invalid'\s*\)\s*\{/.exec(src);
    expect(guard, "run-start handler must branch on validity.status === 'invalid'").not.toBeNull();
    const blockStart = src.indexOf('{', guard!.index);
    let depth = 0;
    let blockEnd = -1;
    for (let i = blockStart; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          blockEnd = i;
          break;
        }
      }
    }
    expect(blockEnd, 'invalid branch block must be brace-balanced').toBeGreaterThan(blockStart);
    const block = src.slice(blockStart, blockEnd + 1);

    const emitIdx = block.indexOf("'SKILL_CONTRACT_INVALID'");
    const triggerIdx = block.indexOf('maybeTriggerValidityRepairReview(');
    expect(emitIdx, 'invalid branch must emit SKILL_CONTRACT_INVALID').toBeGreaterThan(-1);
    expect(
      triggerIdx,
      'invalid branch must call maybeTriggerValidityRepairReview — the 183g primary seam',
    ).toBeGreaterThan(-1);
    expect(
      triggerIdx,
      'the repair trigger fires AFTER the rejection emit (the rejection unblocks the Helmsman first)',
    ).toBeGreaterThan(emitIdx);
    expect(
      block.indexOf('return', triggerIdx),
      'the invalid branch must still terminate (return) after the trigger — never fall through to dispatch',
    ).toBeGreaterThan(-1);
  });
});
