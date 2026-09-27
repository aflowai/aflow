import { describe, expect, it } from 'vitest';

import { discoverHarnesses } from '../harnessDiscovery.js';
import { buildHarnessArgv, buildSessionArgs, HarnessProfileSchema } from '../harnessProfiles.js';

describe('harness discovery', () => {
  it('reports an absolute path for anything it found, not the name it looked for', async () => {
    // The policy should record what was found. A bare name would re-resolve
    // against whatever PATH the executor happens to have later.
    for (const found of await discoverHarnesses()) {
      expect(found.executable.startsWith('/')).toBe(true);
    }
  });

  it('suggests auth paths under the given home rather than the running user home', async () => {
    for (const found of await discoverHarnesses('/Users/someone')) {
      for (const path of found.suggested.authPaths) {
        expect(path.startsWith('/Users/someone/')).toBe(true);
      }
    }
  });

  it('suggests no egress for anything — a domain list is measured, never assumed', async () => {
    for (const found of await discoverHarnesses()) {
      expect(found.suggested).not.toHaveProperty('allowedDomains');
    }
  });

  it('carries no egress and no credential, so writing one grants neither', async () => {
    // A suggestion is shaped enough to become a profile, which is the point —
    // an operator confirms it rather than composing one. What it must never
    // carry is authority: taking a suggestion verbatim grants a harness that
    // can reach nothing and holds nothing.
    for (const found of await discoverHarnesses()) {
      const asProfile = HarnessProfileSchema.parse(found);
      expect(asProfile.allowedDomains).toEqual([]);
      expect(asProfile.credential).toBeUndefined();
    }
  });

  it('names the output format the flags it suggests will actually produce', async () => {
    for (const found of await discoverHarnesses()) {
      const suggestion = found.suggested;
      const asksForStreamJson =
        suggestion.args.includes('--output-format') && suggestion.args.includes('stream-json');
      expect(asksForStreamJson).toBe(suggestion.output === 'claude-stream-json');
      // Measured against the installed CLI: under `--print` it refuses
      // `--output-format stream-json` without `--verbose`, before the run
      // starts. Suggesting one without the other is a harness that never runs.
      if (asksForStreamJson) expect(suggestion.args).toContain('--verbose');
    }
  });

  it('puts those flags on a fresh run and on a resumed one alike', async () => {
    for (const found of await discoverHarnesses()) {
      if (found.suggested.output !== 'claude-stream-json') continue;
      const profile = HarnessProfileSchema.parse({
        id: found.id,
        executable: found.executable,
        args: found.suggested.args,
        output: found.suggested.output,
        promptArgs: found.suggested.promptArgs,
        sessionArgs: found.suggested.sessionArgs,
        resumeArgs: found.suggested.resumeArgs,
      });
      for (const resuming of [false, true]) {
        const argv = buildHarnessArgv(
          profile,
          'the task',
          buildSessionArgs(profile, 'conversation-1', resuming),
        );
        expect(argv).toContain('--output-format');
        expect(argv).toContain('stream-json');
        expect(argv).toContain('--verbose');
        // Before the prompt, which is the last element and never a flag.
        expect(argv.indexOf('--output-format')).toBeLessThan(argv.indexOf('the task'));
      }
    }
  });

  it('suggests the turn-budget flag it measured, and applies it once confirmed', async () => {
    for (const found of await discoverHarnesses()) {
      // Measured against the installed CLI: the one that prints the Claude event
      // stream also takes `--max-turns <turns>` and validates it as a number
      // before the run starts, so a suggestion for it that carries no budget is
      // withholding one the harness has.
      if (found.suggested.output === 'claude-stream-json') {
        expect(found.suggested.turnsArgs).toEqual(['--max-turns', '{turns}']);
      }
      const suggested = found.suggested.turnsArgs;
      if (suggested.length === 0) continue;
      expect(suggested.filter((a) => a === '{turns}')).toHaveLength(1);
      const profile = HarnessProfileSchema.parse({
        id: found.id,
        executable: found.executable,
        promptArgs: found.suggested.promptArgs,
        turnsArgs: suggested,
      });
      const argv = buildHarnessArgv(profile, 'the task', [], 8);
      expect(argv).toContain('8');
      expect(argv.indexOf('8')).toBeLessThan(argv.indexOf('the task'));
    }
  });

  it('suggests the model argument it measured, and applies it once confirmed', async () => {
    for (const found of await discoverHarnesses()) {
      // Measured against the installed CLI alongside the headless flags: the one
      // that prints the Claude event stream takes `--model <model>`, and the
      // run's init event echoes back the name it was given.
      if (found.suggested.output === 'claude-stream-json') {
        expect(found.suggested.modelArgs).toEqual(['--model', '{model}']);
      }
      const suggested = found.suggested.modelArgs;
      if (suggested.length === 0) continue;
      expect(suggested.filter((a) => a === '{model}')).toHaveLength(1);
      const profile = HarnessProfileSchema.parse({
        id: found.id,
        executable: found.executable,
        promptArgs: found.suggested.promptArgs,
        modelArgs: suggested,
      });
      const argv = buildHarnessArgv(profile, 'the task', [], undefined, 'fable');
      expect(argv).toContain('fable');
      expect(argv.indexOf('fable')).toBeLessThan(argv.indexOf('the task'));
    }
  });

  it('carries a name an operator would recognise, distinct from the id', async () => {
    // The id is the wire spelling; a surface with only the id shows `claude`
    // where a person expects `Claude Code`, which is why the probe carries both
    // and a confirmed profile keeps the name.
    for (const found of await discoverHarnesses()) {
      expect(found.label.length).toBeGreaterThan(0);
      const confirmed = HarnessProfileSchema.parse({
        id: found.id,
        label: found.label,
        executable: found.executable,
      });
      expect(confirmed.label).toBe(found.label);
    }
  });

  it('produces a valid profile once an operator confirms a suggestion', async () => {
    for (const found of await discoverHarnesses()) {
      const confirmed = HarnessProfileSchema.parse({
        id: found.id,
        executable: found.executable,
        promptArgs: found.suggested.promptArgs,
        authPaths: found.suggested.authPaths,
      });
      expect(confirmed.allowedDomains).toEqual([]);
      expect(confirmed.promptArgs.filter((a) => a === '{prompt}')).toHaveLength(1);
    }
  });
});
