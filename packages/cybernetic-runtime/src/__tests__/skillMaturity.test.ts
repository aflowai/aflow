import { describe, it, expect } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import {
  countConsecutiveSuccesses,
  computeMaturityTransition,
  deriveSkillMaturity,
  resolveSkillMaturityKnobs,
  type SkillMaturityKnobs,
} from '../skillMaturity.js';
import { shouldActivateCoach } from '../coachTrigger.js';

const KNOBS: SkillMaturityKnobs = {
  practisingRunsFloor: 5,
  masteredRunsFloor: 10,
  masteredConsecutiveSuccesses: 5,
};

describe('deriveSkillMaturity (pure)', () => {
  it('is deterministic — same stats + knobs always yield the same level', () => {
    const stats = { completedRuns: 12, consecutiveSuccesses: 6, recentRegression: false };
    const first = deriveSkillMaturity(stats, KNOBS);
    for (let i = 0; i < 10; i++) {
      expect(deriveSkillMaturity(stats, KNOBS)).toBe(first);
    }
    expect(first).toBe('mastered');
  });

  it('below the practising floor → adhoc', () => {
    expect(
      deriveSkillMaturity(
        { completedRuns: 4, consecutiveSuccesses: 4, recentRegression: false },
        KNOBS,
      ),
    ).toBe('adhoc');
    expect(
      deriveSkillMaturity(
        { completedRuns: 0, consecutiveSuccesses: 0, recentRegression: false },
        KNOBS,
      ),
    ).toBe('adhoc');
  });

  it('at the practising floor but below the mastered bar → practising', () => {
    expect(
      deriveSkillMaturity(
        { completedRuns: 5, consecutiveSuccesses: 5, recentRegression: false },
        KNOBS,
      ),
    ).toBe('practising');
    expect(
      deriveSkillMaturity(
        { completedRuns: 10, consecutiveSuccesses: 4, recentRegression: false },
        KNOBS,
      ),
    ).toBe('practising');
  });

  it('a standing regression blocks mastered (regression-from-peak presence)', () => {
    expect(
      deriveSkillMaturity(
        { completedRuns: 20, consecutiveSuccesses: 10, recentRegression: true },
        KNOBS,
      ),
    ).toBe('practising');
  });

  it('knobs come from named learningPolicy fields, with schema defaults', () => {
    const defaults = resolveSkillMaturityKnobs(undefined);
    expect(defaults).toEqual({
      practisingRunsFloor: 5,
      masteredRunsFloor: 10,
      masteredConsecutiveSuccesses: 5,
    });
  });
});

describe('computeMaturityTransition (pure)', () => {
  it('no prior level → no transition (first projection never flaps)', () => {
    expect(computeMaturityTransition(undefined, 'adhoc')).toBeNull();
  });

  it('same level → no transition', () => {
    expect(computeMaturityTransition('practising', 'practising')).toBeNull();
  });

  it('level change → transition in both directions', () => {
    expect(computeMaturityTransition('practising', 'mastered')).toEqual({
      from: 'practising',
      to: 'mastered',
    });
    expect(computeMaturityTransition('mastered', 'practising')).toEqual({
      from: 'mastered',
      to: 'practising',
    });
  });
});

describe('countConsecutiveSuccesses (pure)', () => {
  it('counts the newest-first success streak, skipping non-terminal rows', () => {
    expect(countConsecutiveSuccesses(['completed', 'running', 'completed', 'failed'])).toBe(2);
    expect(countConsecutiveSuccesses(['failed', 'completed'])).toBe(0);
    expect(countConsecutiveSuccesses(['paused', 'completed', 'cancelled', 'completed'])).toBe(1);
    expect(countConsecutiveSuccesses([])).toBe(0);
  });
});

describe('maturity_signal gate branch (Plan 183 §1.1 ledger — enacted)', () => {
  const dummyDb = {} as unknown as PostgresJsDatabase;
  const dummyRedis = {} as unknown as Redis;

  it('a maturityTransition activates the Coach with source=maturity_signal', async () => {
    const gate = await shouldActivateCoach({
      tenantId: 't',
      spaceId: 's',
      workflowSlug: 'skill-x',
      runId: 'r',
      totalRuns: 50, // past bootstrap; no eval result; no other producer
      maturityTransition: { from: 'practising', to: 'mastered' },
      db: dummyDb,
      redis: dummyRedis,
    });
    expect(gate).not.toBeNull();
    expect(gate?.source).toBe('maturity_signal');
    expect(gate?.reason).toContain('practising → mastered');
  });

  it('no transition + no other signal → gate stays silent (codified_only default)', async () => {
    const gate = await shouldActivateCoach({
      tenantId: 't',
      spaceId: 's',
      workflowSlug: 'skill-x',
      runId: 'r',
      totalRuns: 50,
      db: dummyDb,
      redis: dummyRedis,
    });
    expect(gate).toBeNull();
  });
});
