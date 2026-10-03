/**
 * Contract: a run that names no turn budget gets the operation's default on a
 * harness that can take one, and none on a harness that cannot — so a brief
 * that leaves the budget out runs on every harness a machine offers, and a
 * budget a run does name is never silently dropped.
 */
import { describe, expect, it } from 'vitest';

import { HOST_HARNESS_MAX_TURNS_DEFAULT, HostHarnessRunInputSchema } from '@aflow/schemas';

import { effectiveMaxTurns, harnessTurnArgv } from '../handlers/harnessHandlers.js';
import { HarnessProfileError, HarnessProfileSchema } from '../harnessProfiles.js';

const TAKES_A_BUDGET = HarnessProfileSchema.parse({
  id: 'claude',
  executable: '/usr/local/bin/claude',
  turnsArgs: ['--max-turns', '{turns}'],
});

// The shape of the built-in OpenCode profile: no turn argument at all.
const TAKES_NONE = HarnessProfileSchema.parse({
  id: 'opencode',
  executable: '/usr/local/bin/opencode',
  promptArgs: ['run', '{prompt}'],
  turnsArgs: [],
});

const UNNAMED = HostHarnessRunInputSchema.parse({ bindingId: 'hb_project', task: 't' });
const NAMED = HostHarnessRunInputSchema.parse({ bindingId: 'hb_project', task: 't', maxTurns: 40 });

function turnFlag(argv: string[]): string[] {
  const at = argv.indexOf('--max-turns');
  return at === -1 ? [] : argv.slice(at, at + 2);
}

describe('the turn budget a harness run gets', () => {
  it('is the operation default on a harness that takes one, when the run names none', () => {
    expect(effectiveMaxTurns(TAKES_A_BUDGET, undefined)).toBe(HOST_HARNESS_MAX_TURNS_DEFAULT);
    expect(turnFlag(harnessTurnArgv(TAKES_A_BUDGET, UNNAMED, 't', 'c-1', false))).toEqual([
      '--max-turns',
      String(HOST_HARNESS_MAX_TURNS_DEFAULT),
    ]);
  });

  it("is the run's own budget wherever it names one", () => {
    expect(turnFlag(harnessTurnArgv(TAKES_A_BUDGET, NAMED, 't', 'c-1', false))).toEqual([
      '--max-turns',
      '40',
    ]);
  });

  it('is none on a harness without turnsArgs, which then runs rather than refusing', () => {
    expect(effectiveMaxTurns(TAKES_NONE, undefined)).toBeUndefined();
    expect(harnessTurnArgv(TAKES_NONE, UNNAMED, 't', 'c-1', false)).toEqual([
      '/usr/local/bin/opencode',
      'run',
      't',
    ]);
  });

  it('is still refused by name on a harness without turnsArgs when the run names one', () => {
    try {
      harnessTurnArgv(TAKES_NONE, NAMED, 't', 'c-1', false);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessProfileError);
      expect((error as HarnessProfileError).kind).toBe('unsupported_request');
      expect((error as Error).message).toContain("Harness 'opencode'");
    }
  });
});
