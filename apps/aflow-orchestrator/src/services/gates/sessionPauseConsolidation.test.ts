/**
 * Guard: parking a session is a privilege with an obligation attached.
 *
 * A pause is only resumable when it carries a resume contract AND reaches
 * whoever is waiting — for an autonomous session (delegated child or
 * workflow-task runner) that means `routeSessionPauseToSubscribers` after the
 * pause commits. Notification is one-shot: nothing later reconciles a paused
 * child with a waiting parent, so a pause writer that skips routing strands
 * the parent permanently. That is the failure class behind Plan 270.
 *
 * This is a tripwire, not a proof: any NEW file that starts writing
 * `status: 'PAUSED'` fails here and must either route through
 * `routeSessionPauseToSubscribers`, feed an allowlisted funnel (waitForInput,
 * applyResult), or join the allowlist with a reason a reviewer can check.
 */
import { readdir, readFile, access } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

async function findRepoRoot(from: string): Promise<string> {
  let dir = from;
  const { root } = parse(dir);
  while (dir !== root) {
    try {
      await access(join(dir, 'yarn.lock'));
      return dir;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error(`repo root not found above ${from}`);
}

const repoRoot = await findRepoRoot(dirname(fileURLToPath(import.meta.url)));

const SEARCH_ROOTS = [
  join(repoRoot, 'apps/aflow-orchestrator/src'),
  join(repoRoot, 'packages/server-runtime/src'),
  join(repoRoot, 'apps/server/src'),
];

/**
 * Files that may contain a `status: 'PAUSED'` write today, each with the
 * reason it is allowed to. Session-level writers either route, feed a routing
 * funnel, or replay state that was already routed when first written.
 */
const ALLOWED_PAUSE_WRITERS = new Set([
  // The canonical pause funnel — producers route after it, directly or through
  // applyResult's post-`handled` sweep.
  'apps/aflow-orchestrator/src/services/StepService/StepService.ts',
  // Routes via routeSessionPauseToSubscribers after the pause commits.
  'apps/aflow-orchestrator/src/services/SessionOrchestrator/scheduling/applyResult.ts',
  'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/applyStepSucceeded.ts',
  'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/agentDecisionRecovery.ts',
  'apps/aflow-orchestrator/src/services/SessionOrchestrator/lifecycle/forceCompleteInFlightStep.ts',
  // Agent-decision pauses (budget, guardrail, pause_for_input, decision-side
  // interrupt) return handled=true; applyResult's post-`handled` sweep routes
  // whatever state they left PAUSED.
  'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/applyAgentDecision.ts',
  'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/guardrailEscalationPause.ts',
  // Pauses at session creation; startRun routes right after it returns.
  'apps/aflow-orchestrator/src/services/SessionOrchestrator/helpers/inputPause.ts',
  'apps/aflow-orchestrator/src/services/SessionOrchestrator/lifecycle/startRun.ts',
  // The PAUSED literal is a field in the synthetic tool-result payload
  // describing the CHILD; the function wakes the parent (step back to STARTED,
  // SessionResumed) rather than parking it.
  'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/bubbleChildPause.ts',
  // Step-level PAUSED results consumed by applyResult's routing branch.
  'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/inlineOps/delegate.ts',
  'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/inlineOps/helpers.ts',
  'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/inlineOps/resume.ts',
  'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/inlineOps/runnerOutput.ts',
  // Replays previously-routed pauses / patches recovery baselines.
  'apps/aflow-orchestrator/src/services/RecoveryService.ts',
  'apps/aflow-orchestrator/src/services/SessionOrchestrator/helpers/recoveryEmitter.ts',
  // Refuses a resume and reports the run still paused — not a new pause.
  'apps/aflow-orchestrator/src/services/SessionOrchestrator/lifecycle/resumeRun.ts',
  // Client-facing status projection, not an orchestration pause.
  'packages/server-runtime/src/services/sessions.ts',
]);

async function collectSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') {
        continue;
      }
      out.push(...(await collectSourceFiles(full)));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.includes('.test.') || entry.name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

describe('session pause consolidation', () => {
  it('every file that writes a PAUSED status is allowlisted with a routing story', async () => {
    const offenders: string[] = [];
    for (const root of SEARCH_ROOTS) {
      const sources = await collectSourceFiles(root);
      expect(sources.length).toBeGreaterThan(0);
      for (const file of sources) {
        const src = await readFile(file, 'utf-8');
        if (!src.includes("status: 'PAUSED'")) continue;
        const rel = file.slice(repoRoot.length + 1);
        if (!ALLOWED_PAUSE_WRITERS.has(rel)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the allowlist carries no dead entries', async () => {
    const stale: string[] = [];
    for (const rel of ALLOWED_PAUSE_WRITERS) {
      const src = await readFile(join(repoRoot, rel), 'utf-8').catch(() => null);
      if (src === null || !src.includes("status: 'PAUSED'")) stale.push(rel);
    }
    expect(stale).toEqual([]);
  });

  it('every producer that routes directly still calls the chokepoint', async () => {
    const mustRoute = [
      // The post-`handled` sweep plus the executor-pause branch.
      'apps/aflow-orchestrator/src/services/SessionOrchestrator/scheduling/applyResult.ts',
      // Interrupt-observed on the normal-success path — no sweep runs after it.
      'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/applyStepSucceeded.ts',
      // Invalid-decision pause is reached from the FAILED branch — no sweep.
      'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/agentDecisionRecovery.ts',
      // Missing-variables pause at session creation — no sweep.
      'apps/aflow-orchestrator/src/services/SessionOrchestrator/lifecycle/startRun.ts',
      // Missing-variables pause at step scheduling — no sweep.
      'apps/aflow-orchestrator/src/services/SessionOrchestrator/scheduling/scheduleStep.ts',
      // Watchdog / orphan-recovery / interrupt force-pause — no sweep.
      'apps/aflow-orchestrator/src/services/SessionOrchestrator/lifecycle/forceCompleteInFlightStep.ts',
    ];
    const missing: string[] = [];
    for (const rel of mustRoute) {
      const src = await readFile(join(repoRoot, rel), 'utf-8');
      if (!src.includes('routeSessionPauseToSubscribers(')) missing.push(rel);
    }
    expect(missing).toEqual([]);
  });
});
