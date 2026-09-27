import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Payload paths are deterministic per (stepExecutionId, attempt, kind), so two
 * writers sharing a kind for one step execution do not conflict — the second
 * silently REPLACES the first.
 *
 * The executor writes conversation atom batches under 'history'. When the
 * orchestrator wrote its `ai.history.<stepId>` record under the same kind, one
 * clobbered the other, and the damage surfaced a turn later: hydration found
 * the surviving payload, failed to find its atoms inside it, and reported "0
 * failed batch(es), N atom issue(s)" — a run that dies on a healthy-looking
 * fetch. It cost 5 of 32 eval trials before it was traced.
 */
const aiHistorySource = readFileSync(
  fileURLToPath(new URL('../SessionOrchestrator/helpers/aiHistory.ts', import.meta.url)),
  'utf8',
);

describe('orchestrator conversation payload kind', () => {
  it('never writes under the executor’s history kind', () => {
    expect(
      aiHistorySource.includes("kind: 'history'"),
      "aiHistory.ts must not store under kind 'history' — that path belongs to the executor's " +
        "atom batches for the same step execution. Use kind: 'conversation'.",
    ).toBe(false);
  });

  it('writes the conversation record under its own kind', () => {
    expect(aiHistorySource).toContain("kind: 'conversation'");
  });
});
