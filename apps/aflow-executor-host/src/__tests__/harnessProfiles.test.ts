import { describe, expect, it } from 'vitest';

import {
  buildHarnessArgv,
  buildSessionArgs,
  HarnessProfileError,
  HarnessProfileSchema,
  requireProfile,
  type HarnessProfile,
} from '../harnessProfiles.js';

function profile(overrides: Partial<HarnessProfile> = {}): HarnessProfile {
  return HarnessProfileSchema.parse({
    id: 'claude',
    executable: '/usr/local/bin/claude',
    ...overrides,
  });
}

describe('harness profiles', () => {
  it('grants nothing by default — no auth paths, no egress', () => {
    const p = profile();
    expect(p.authPaths).toEqual([]);
    expect(p.allowedDomains).toEqual([]);
  });

  it('names the configured harnesses when one is not found', () => {
    const profiles = new Map([['claude', profile()]]);
    expect(() => requireProfile(profiles, 'opencode')).toThrow(HarnessProfileError);
    try {
      requireProfile(profiles, 'opencode');
    } catch (error) {
      expect((error as Error).message).toContain('claude');
      expect((error as HarnessProfileError).kind).toBe('unknown_profile');
    }
  });

  it('says none are configured rather than listing an empty set', () => {
    try {
      requireProfile(new Map(), 'claude');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('No coding harness is configured');
    }
  });

  it('keeps the task in one argv element, so prose cannot become arguments', () => {
    const argv = buildHarnessArgv(
      profile({ args: ['--model', 'sonnet'], promptArgs: ['-p', '{prompt}'] }),
      'rm -rf / ; echo "pwned" --flag',
    );
    expect(argv).toEqual([
      '/usr/local/bin/claude',
      '--model',
      'sonnet',
      '-p',
      'rm -rf / ; echo "pwned" --flag',
    ]);
  });

  it('refuses a profile whose prompt has nowhere to go, or two places', () => {
    expect(() => buildHarnessArgv(profile({ promptArgs: ['--headless'] }), 'x')).toThrow(
      /exactly one/,
    );
    expect(() => buildHarnessArgv(profile({ promptArgs: ['{prompt}', '{prompt}'] }), 'x')).toThrow(
      /exactly one/,
    );
  });

  it('puts the turn budget on the argv, before the prompt, fresh and resumed alike', () => {
    const p = profile({
      args: ['-p'],
      promptArgs: ['{prompt}'],
      sessionArgs: ['--session-id', '{session}'],
      resumeArgs: ['--resume', '{session}'],
      turnsArgs: ['--max-turns', '{turns}'],
    });
    for (const resuming of [false, true]) {
      const argv = buildHarnessArgv(p, 'the task', buildSessionArgs(p, 'c1', resuming), 8);
      expect(argv).toContain('--max-turns');
      expect(argv[argv.indexOf('--max-turns') + 1]).toBe('8');
      expect(argv.indexOf('--max-turns')).toBeLessThan(argv.indexOf('the task'));
    }
  });

  it('leaves the argv alone when no budget was asked for', () => {
    const argv = buildHarnessArgv(profile({ turnsArgs: ['--max-turns', '{turns}'] }), 'the task');
    expect(argv).not.toContain('--max-turns');
  });

  it('refuses a budget the harness has no flag for, naming it', () => {
    try {
      buildHarnessArgv(profile({ id: 'opencode', turnsArgs: [] }), 'the task', [], 8);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('opencode');
      expect((error as Error).message).toContain('maxTurns');
      // Resending without the budget is the remedy, so it is a validation
      // refusal rather than a grant the operator has to make.
      expect((error as HarnessProfileError).kind).toBe('unsupported_request');
    }
  });

  it('refuses a turns template with nowhere to put the number, or two places', () => {
    expect(() => buildHarnessArgv(profile({ turnsArgs: ['--max-turns'] }), 'x', [], 4)).toThrow(
      /exactly one/,
    );
    expect(() =>
      buildHarnessArgv(profile({ turnsArgs: ['{turns}', '{turns}'] }), 'x', [], 4),
    ).toThrow(/exactly one/);
  });

  it('puts the model on the argv, before the prompt, fresh and resumed alike', () => {
    const p = profile({
      args: ['-p'],
      promptArgs: ['{prompt}'],
      sessionArgs: ['--session-id', '{session}'],
      resumeArgs: ['--resume', '{session}'],
      modelArgs: ['--model', '{model}'],
    });
    for (const resuming of [false, true]) {
      const argv = buildHarnessArgv(
        p,
        'the task',
        buildSessionArgs(p, 'c1', resuming),
        undefined,
        'fable',
      );
      expect(argv[argv.indexOf('--model') + 1]).toBe('fable');
      expect(argv.indexOf('--model')).toBeLessThan(argv.indexOf('the task'));
    }
  });

  it('leaves the argv alone when no model was named', () => {
    const argv = buildHarnessArgv(profile({ modelArgs: ['--model', '{model}'] }), 'the task');
    expect(argv).not.toContain('--model');
  });

  it('refuses a model the harness has no argument for, naming it', () => {
    try {
      buildHarnessArgv(
        profile({ id: 'opencode', modelArgs: [] }),
        'the task',
        [],
        undefined,
        'gpt',
      );
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('opencode');
      expect((error as Error).message).toContain('model');
      // Running the harness's own default instead would answer a different
      // question than the one a pinned model asked, so resending without it is
      // the remedy rather than an operator grant.
      expect((error as HarnessProfileError).kind).toBe('unsupported_request');
    }
  });

  it('refuses a model template with nowhere to put the name, or two places', () => {
    expect(() =>
      buildHarnessArgv(profile({ modelArgs: ['--model'] }), 'x', [], undefined, 'fable'),
    ).toThrow(/exactly one/);
    expect(() =>
      buildHarnessArgv(profile({ modelArgs: ['{model}', '{model}'] }), 'x', [], undefined, 'fable'),
    ).toThrow(/exactly one/);
  });

  it('carries the budget and the model together, each in its own element', () => {
    const argv = buildHarnessArgv(
      profile({
        promptArgs: ['-p', '{prompt}'],
        turnsArgs: ['--max-turns', '{turns}'],
        modelArgs: ['--model', '{model}'],
      }),
      'the task',
      [],
      8,
      'fable',
    );
    expect(argv).toEqual([
      '/usr/local/bin/claude',
      '--max-turns',
      '8',
      '--model',
      'fable',
      '-p',
      'the task',
    ]);
  });

  it('runs the profile model when the run names none', () => {
    const argv = buildHarnessArgv(
      profile({ modelArgs: ['--model', '{model}'], model: 'fable' }),
      'the task',
    );
    expect(argv).toEqual(['/usr/local/bin/claude', '--model', 'fable', 'the task']);
  });

  it('prefers the run model, then the profile model, then the harness default', () => {
    const withDefault = profile({ modelArgs: ['--model', '{model}'], model: 'fable' });
    const withoutDefault = profile({ modelArgs: ['--model', '{model}'] });
    const modelOf = (argv: string[]): string | undefined =>
      argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : undefined;

    const runWins = buildHarnessArgv(withDefault, 't', [], undefined, 'parable');
    expect(modelOf(runWins)).toBe('parable');
    expect(runWins).not.toContain('fable');
    expect(runWins.filter((a) => a === '--model')).toHaveLength(1);

    expect(modelOf(buildHarnessArgv(withDefault, 't'))).toBe('fable');

    expect(buildHarnessArgv(withoutDefault, 't')).toEqual(['/usr/local/bin/claude', 't']);
  });

  it('refuses a profile model the harness has no argument for, as it refuses a run model', () => {
    const p = profile({ id: 'opencode', modelArgs: [], model: 'fable' });
    try {
      buildHarnessArgv(p, 'the task');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessProfileError);
      expect((error as HarnessProfileError).kind).toBe('unsupported_request');
      expect((error as Error).message).toContain('opencode');
      expect((error as Error).message).toContain('fable');
    }
    expect(() => buildHarnessArgv(p, 'the task', [], undefined, 'parable')).toThrow(
      HarnessProfileError,
    );
  });

  it('carries no model unless one is configured, and refuses an empty one', () => {
    expect(profile().model).toBeUndefined();
    expect(() => profile({ model: '' })).toThrow();
  });

  it('never lets a request name the executable — only an id the machine defined', () => {
    // The op takes `harness: string`; everything about what runs comes from the
    // machine's own file. This asserts the profile is the only source.
    const profiles = new Map([['claude', profile({ executable: '/opt/claude' })]]);
    expect(buildHarnessArgv(requireProfile(profiles, 'claude'), 't')[0]).toBe('/opt/claude');
  });
});
