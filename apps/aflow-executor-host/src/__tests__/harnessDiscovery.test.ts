import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoverHarnesses, knownMcpArgs, type DiscoveredHarness } from '../harnessDiscovery.js';
import {
  buildHarnessArgv,
  buildSessionArgs,
  HarnessProfileError,
  HarnessProfileSchema,
} from '../harnessProfiles.js';

// Discovery finds only what is installed, so a machine with no harness would
// run these loops zero times and pass. This one is always there.
const FIXED_HARNESS: DiscoveredHarness = {
  id: 'claude',
  label: 'Claude Code',
  executable: '/usr/local/bin/claude',
  version: 'fixed',
  suggested: {
    promptArgs: ['-p', '{prompt}'],
    args: [],
    output: 'text',
    sessionArgs: [],
    resumeArgs: [],
    turnsArgs: [],
    modelArgs: ['--model', '{model}'],
    mcpArgs: ['--mcp-config', '{mcpConfig}', '--strict-mcp-config'],
    authPaths: [],
    writePaths: [],
    configSeed: [],
    env: {},
  },
};

async function withFixedHarness(): Promise<DiscoveredHarness[]> {
  return [FIXED_HARNESS, ...(await discoverHarnesses())];
}

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

  it('hands Claude Code a browser through its own MCP configuration and nothing else', async () => {
    // Measured under the lane's flags: given `--mcp-config <file>`, the init
    // event reports the stdio server connected and the model calls its tools;
    // `--strict-mcp-config` leaves out every server the operator configured.
    expect(knownMcpArgs('claude')).toEqual(['--mcp-config', '{mcpConfig}', '--strict-mcp-config']);
    expect(knownMcpArgs('opencode')).toBeUndefined();
    for (const found of await withFixedHarness()) {
      if (found.suggested.output === 'claude-stream-json' || found === FIXED_HARNESS) {
        expect(found.suggested.mcpArgs).toEqual(knownMcpArgs('claude'));
      }
      const confirmed = HarnessProfileSchema.parse({
        id: found.id,
        executable: found.executable,
        promptArgs: found.suggested.promptArgs,
        mcpArgs: found.suggested.mcpArgs,
      });
      if (confirmed.mcpArgs.length === 0) {
        expect(() =>
          buildHarnessArgv(confirmed, 'the task', [], undefined, undefined, '/s/mcp.json'),
        ).toThrow(HarnessProfileError);
        continue;
      }
      const argv = buildHarnessArgv(confirmed, 'the task', [], undefined, undefined, '/s/mcp.json');
      expect(argv.slice(argv.indexOf('--mcp-config'), argv.indexOf('--mcp-config') + 3)).toEqual([
        '--mcp-config',
        '/s/mcp.json',
        '--strict-mcp-config',
      ]);
      expect(argv.indexOf('/s/mcp.json')).toBeLessThan(argv.indexOf('the task'));
      expect(buildHarnessArgv(confirmed, 'the task')).not.toContain('--mcp-config');
    }
  });

  it('suggests no model, so a confirmed suggestion runs the harness default', async () => {
    // Which model runs is the operator's choice; discovery measures only how
    // a model is passed.
    for (const found of await withFixedHarness()) {
      expect(found.suggested).not.toHaveProperty('model');
      const confirmed = HarnessProfileSchema.parse({
        id: found.id,
        executable: found.executable,
        promptArgs: found.suggested.promptArgs,
        modelArgs: found.suggested.modelArgs,
      });
      expect(confirmed.model).toBeUndefined();
      expect(buildHarnessArgv(confirmed, 'the task')).not.toContain('{model}');
    }
  });

  it('applies a model the operator adds to a confirmed suggestion', async () => {
    for (const found of await withFixedHarness()) {
      if (found.suggested.modelArgs.length === 0) continue;
      const confirmed = HarnessProfileSchema.parse({
        id: found.id,
        executable: found.executable,
        promptArgs: found.suggested.promptArgs,
        modelArgs: found.suggested.modelArgs,
        model: 'fable',
      });
      const argv = buildHarnessArgv(confirmed, 'the task');
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

describe('the Codex profile', () => {
  /** Discovery as it runs on a machine where `codex` is the only thing on PATH. */
  async function discoverCodex(): Promise<DiscoveredHarness> {
    const bin = await mkdtemp(join(tmpdir(), 'aflow-codex-bin-'));
    const savedPath = process.env['PATH'];
    try {
      await writeFile(join(bin, 'codex'), '#!/bin/sh\necho codex-cli 0.0.0\n');
      await chmod(join(bin, 'codex'), 0o755);
      process.env['PATH'] = `${bin}:/usr/bin:/bin`;
      const found = (await discoverHarnesses('/Users/someone')).find((d) => d.id === 'codex');
      if (found === undefined) throw new Error('codex was not discovered');
      return found;
    } finally {
      process.env['PATH'] = savedPath;
      await rm(bin, { recursive: true, force: true });
    }
  }

  function codexProfile(found: DiscoveredHarness): ReturnType<typeof HarnessProfileSchema.parse> {
    return HarnessProfileSchema.parse({
      id: found.id,
      executable: found.executable,
      ...found.suggested,
    });
  }

  it('starts a new conversation without naming it, since Codex names its own', async () => {
    const profile = codexProfile(await discoverCodex());
    const argv = buildHarnessArgv(profile, 'the task', buildSessionArgs(profile, undefined, false));
    expect(argv.slice(1, 4)).toEqual([
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
    expect(argv).not.toContain('resume');
    expect(argv.at(-1)).toBe('the task');
  });

  it("resumes by the id Codex reported, after exec's flags so they carry over", async () => {
    const profile = codexProfile(await discoverCodex());
    const argv = buildHarnessArgv(
      profile,
      'next',
      buildSessionArgs(profile, 'thread-1', true),
      undefined,
      'gpt-x',
    );
    const resume = argv.indexOf('resume');
    expect(argv[resume + 1]).toBe('thread-1');
    expect(argv.indexOf('--json')).toBeLessThan(resume);
    expect(argv.lastIndexOf('--disable')).toBeLessThan(resume);
    expect(argv.slice(resume + 2)).toEqual(['-m', 'gpt-x', 'next']);
  });

  it.runIf(process.platform === 'darwin')(
    'hands it the system bundle on macOS, where it would otherwise ask the trust daemon',
    async () => {
      const found = await discoverCodex();
      expect(found.suggested.env).toEqual({ CODEX_CA_CERTIFICATE: '/etc/ssl/cert.pem' });
      expect(() => codexProfile(found)).not.toThrow();
    },
  );

  it('lends the sign-in under the given home into a CODEX_HOME of the run', async () => {
    const found = await discoverCodex();
    expect(found.suggested.configDirEnv).toBe('CODEX_HOME');
    expect(found.suggested.configSeed).toEqual(['/Users/someone/.codex/auth.json']);
    expect(found.suggested.authPaths).toEqual([]);
  });
});
