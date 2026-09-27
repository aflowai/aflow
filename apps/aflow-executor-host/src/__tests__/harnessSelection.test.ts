/**
 * Contract: a run does not have to know the harness id. The machine holds the
 * one fact that decides it, so a caller that names nothing gets the harness the
 * machine offers — and a machine offering several says which, rather than
 * choosing for the operator.
 */
import { describe, expect, it } from 'vitest';

import { selectHarness } from '../handlers/harnessHandlers.js';
import { buildHarnessArgv, HarnessProfileError, HarnessProfileSchema } from '../harnessProfiles.js';
import type { HarnessProfile } from '../harnessProfiles.js';

function profile(id: string, label?: string): HarnessProfile {
  return HarnessProfileSchema.parse({
    id,
    executable: `/usr/local/bin/${id}`,
    ...(label !== undefined ? { label } : {}),
  });
}

function profiles(...ids: string[]): ReadonlyMap<string, HarnessProfile> {
  return new Map(ids.map((id) => [id, profile(id)]));
}

describe('choosing a harness', () => {
  it('uses the only one offered when the call named none', () => {
    const selection = selectHarness(profiles('claude'), undefined);
    expect(selection.kind).toBe('profile');
    expect(selection.kind === 'profile' && selection.profile.id).toBe('claude');
  });

  it('names every id when several are offered, instead of picking one', () => {
    const selection = selectHarness(profiles('opencode', 'claude'), undefined);
    expect(selection.kind).toBe('ambiguous');
    const problem = selection.kind === 'ambiguous' ? selection.problem : '';
    expect(problem).toContain('claude');
    expect(problem).toContain('opencode');
    expect(problem).toContain('harness');
  });

  it('gives the operator name beside each id, since the choice is theirs to read', () => {
    // `harness` takes the id and nothing else, so the id leads; the name follows
    // it because a choice between two ids is one nobody can make from the ids.
    const available = new Map([
      ['claude', profile('claude', 'Claude Code')],
      ['homegrown', profile('homegrown')],
    ]);
    const selection = selectHarness(available, undefined);
    const problem = selection.kind === 'ambiguous' ? selection.problem : '';
    expect(problem).toContain('claude (Claude Code)');
    expect(problem).toContain('homegrown');
    expect(problem).not.toContain('homegrown (');
  });

  it('says none are configured rather than reporting an empty choice', () => {
    expect(() => selectHarness(profiles(), undefined)).toThrow(HarnessProfileError);
    try {
      selectHarness(profiles(), undefined);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('No coding harness is configured');
      expect((error as HarnessProfileError).kind).toBe('unknown_profile');
    }
  });

  it('brings the chosen profile model with it, which a run model still overrides', () => {
    const configured = HarnessProfileSchema.parse({
      id: 'claude',
      executable: '/usr/local/bin/claude',
      modelArgs: ['--model', '{model}'],
      model: 'fable',
    });
    const selection = selectHarness(new Map([['claude', configured]]), undefined);
    if (selection.kind !== 'profile') throw new Error('expected a profile');
    expect(buildHarnessArgv(selection.profile, 't')).toContain('fable');
    const overridden = buildHarnessArgv(selection.profile, 't', [], undefined, 'parable');
    expect(overridden).toContain('parable');
    expect(overridden).not.toContain('fable');
  });

  it('still resolves a named id against the machine, and refuses an unknown one', () => {
    const available = profiles('claude', 'opencode');
    const selection = selectHarness(available, 'opencode');
    expect(selection.kind === 'profile' && selection.profile.id).toBe('opencode');
    expect(() => selectHarness(available, 'amp')).toThrow(HarnessProfileError);
  });
});
