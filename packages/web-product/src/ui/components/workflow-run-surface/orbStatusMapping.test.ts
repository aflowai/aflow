import { describe, expect, it } from 'vitest';
import { orbForRunStatus, orbForTaskStatus } from './workflowRunSurfaceHelpers.js';

describe('orbForRunStatus', () => {
  it('maps live work to running', () => {
    expect(orbForRunStatus('running')).toBe('running');
    expect(orbForRunStatus('in_flight')).toBe('running');
  });

  it('maps paused (user action expected) to paused', () => {
    expect(orbForRunStatus('paused')).toBe('paused');
  });

  it('maps terminal success to completed', () => {
    expect(orbForRunStatus('completed')).toBe('completed');
  });

  it('maps failure/cancel to failed', () => {
    expect(orbForRunStatus('failed')).toBe('failed');
    expect(orbForRunStatus('cancelled')).toBe('failed');
  });

  it('maps skipped to inert', () => {
    expect(orbForRunStatus('skipped')).toBe('inert');
  });
});

describe('orbForTaskStatus', () => {
  it('maps lifecycle statuses', () => {
    expect(orbForTaskStatus('running')).toBe('running');
    expect(orbForTaskStatus('paused')).toBe('paused');
    expect(orbForTaskStatus('succeeded')).toBe('completed');
    expect(orbForTaskStatus('failed')).toBe('failed');
    expect(orbForTaskStatus('cancelled')).toBe('failed');
  });

  it('maps dependency-held / not-taken to inert', () => {
    expect(orbForTaskStatus('blocked')).toBe('inert');
    expect(orbForTaskStatus('scheduled')).toBe('inert');
    expect(orbForTaskStatus('skipped')).toBe('inert');
  });

  it('surfaces stalled running as failed', () => {
    expect(orbForTaskStatus('running', { stalled: true })).toBe('failed');
    expect(orbForTaskStatus('paused', { stalled: true })).toBe('paused');
  });
});
