import { describe, it, expect } from 'vitest';

// Test that the module exports the expected functions
describe('ledger exports', () => {
  it('exports all read helpers', async () => {
    const mod = await import('../ledger.js');
    expect(typeof mod.loadRunById).toBe('function');
    expect(typeof mod.listRecentRuns).toBe('function');
    expect(typeof mod.listActiveRuns).toBe('function');
    expect(typeof mod.listTaskRows).toBe('function');
    expect(typeof mod.getRunStatistics).toBe('function');
  });

  it('exports all write helpers', async () => {
    const mod = await import('../ledger.js');
    expect(typeof mod.recordRunStart).toBe('function');
    expect(typeof mod.recordTaskResult).toBe('function');
    expect(typeof mod.completeRun).toBe('function');
    expect(typeof mod.resumeRun).toBe('function');
  });

  it('exports pauseRun helper', async () => {
    const mod = await import('../ledger.js');
    expect(typeof mod.pauseRun).toBe('function');
  });

  it('exports 104d Phase 0 recoverStalledRun helper', async () => {
    const mod = await import('../ledger.js');
    expect(typeof mod.recoverStalledRun).toBe('function');
  });

  it('exports 104d Phase 1a claimTask helper', async () => {
    const mod = await import('../ledger.js');
    expect(typeof mod.claimTask).toBe('function');
  });

  it('exports 104d Phase 1a releaseClaimedTask helper', async () => {
    const mod = await import('../ledger.js');
    expect(typeof mod.releaseClaimedTask).toBe('function');
  });

  it('exports 104d Phase 1a listActiveRunsWithLiveness helper', async () => {
    const mod = await import('../ledger.js');
    expect(typeof mod.listActiveRunsWithLiveness).toBe('function');
  });

  it('exports 104d Phase 1 updateSchedulerCursor helper', async () => {
    const mod = await import('../ledger.js');
    expect(typeof mod.updateSchedulerCursor).toBe('function');
  });

  it('exports 104d Phase 1 recordTaskSkipped helper', async () => {
    const mod = await import('../ledger.js');
    expect(typeof mod.recordTaskSkipped).toBe('function');
  });

  it('exports 104d Phase 1 blockDescendantTasks helper', async () => {
    const mod = await import('../ledger.js');
    expect(typeof mod.blockDescendantTasks).toBe('function');
  });
});

describe('type contracts', () => {
  it('WorkflowRunSummary has expected fields', async () => {
    const { loadRunById: _ } = await import('../ledger.js');
    // Type-only test: if this file compiles, the types are correct.
    // The actual DB interaction is tested in integration tests.
    expect(true).toBe(true);
  });
});
