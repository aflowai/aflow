import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { HostBindingSchema, HostPolicySchema } from '../bindings.js';
import { HarnessProfileSchema } from '../harnessProfiles.js';
import { compileSandboxPolicy, FORBIDDEN_SANDBOX_OPTIONS } from '../sandboxPolicy.js';

const SRC = join(fileURLToPath(new URL('../', import.meta.url)));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === '__tests__' || entry === 'dist' ? [] : sourceFiles(full);
    }
    return entry.endsWith('.ts') && !entry.endsWith('.test.ts') ? [full] : [];
  });
}

const binding = HostBindingSchema.parse({
  id: 'hb_project',
  root: '/Users/op/project',
  mode: 'read',
  allowsExecution: true,
});

describe('a harness widening stays a widening', () => {
  it('opens exactly the auth paths and domains the profile named, and nothing else', () => {
    const policy = compileSandboxPolicy(binding, {
      home: '/Users/op',
      scratchDir: '/tmp/scratch',
      widening: {
        authPaths: ['/Users/op/.claude'],
        allowedDomains: ['api.anthropic.com'],
        writableRoot: '/tmp/scratch/work',
      },
    });
    expect(policy.filesystem.allowRead).toContain('/Users/op/.claude');
    expect(policy.network.allowedDomains).toEqual(['api.anthropic.com']);
    // Home as a region is still denied; the profile carved one path out of it.
    expect(policy.filesystem.denyRead).toContain('/Users/op');
    expect(policy.filesystem.allowRead).not.toContain('/Users/op');
    expect(policy.filesystem.allowRead).not.toContain('/Users/op/.ssh');
  });

  it('gives a harness its worktree and not the connected folder', () => {
    // The whole point of the worktree: a harness edits an isolated checkout, so
    // it never needs write access to the folder the operator connected. That
    // holds whichever mode the binding carries — see the withheld-write case in
    // boundaryRegressions for the writable binding a worktree actually requires.
    const policy = compileSandboxPolicy(binding, {
      home: '/Users/op',
      scratchDir: '/tmp/scratch',
      widening: { authPaths: [], allowedDomains: [], writableRoot: '/tmp/scratch/work' },
    });
    expect(policy.filesystem.allowWrite).not.toContain('/Users/op/project');
    expect(policy.filesystem.allowWrite).toContain('/tmp/scratch/work');
  });

  it('still grants no egress when a profile named no domain', () => {
    const policy = compileSandboxPolicy(binding, {
      home: '/Users/op',
      scratchDir: '/tmp/scratch',
      widening: { authPaths: [], allowedDomains: [] },
    });
    expect(policy.network.allowedDomains).toEqual([]);
  });

  it('never emits an option that voids the contract, widening or not', () => {
    const policy = compileSandboxPolicy(binding, {
      home: '/Users/op',
      scratchDir: '/tmp/scratch',
      widening: {
        authPaths: ['/Users/op/.claude'],
        allowedDomains: ['api.anthropic.com'],
        writableRoot: '/tmp/w',
      },
    });
    const serialized = JSON.stringify(policy);
    for (const option of FORBIDDEN_SANDBOX_OPTIONS) {
      expect(serialized).not.toContain(option);
    }
  });

  it('cannot be widened by a request — a profile comes only from the machine policy file', () => {
    // If the wire schema ever grew a field carrying an executable, an auth path
    // or a domain, the machine would stop being the authority on what runs.
    const wire = readFileSync(
      join(SRC, '../../../packages/schemas/src/operations/host.ts'),
      'utf8',
    );
    const harnessInput = wire.slice(
      wire.indexOf('HostHarnessRunInputSchema'),
      wire.indexOf('HostHarnessRunOutputSchema'),
    );
    // Field names only — descriptions are prose and may name what they exclude.
    // Pinned exactly, so a new field has to be argued for here: each of these
    // names something the machine already permits rather than adding to it.
    // `continueFrom` names a session this run already owns, and ownership is
    // checked before it resolves to anything. `outputSchema` and
    // `resultRetries` shape what the run must hand back and how many turns it
    // gets to hand it back correctly; neither reaches the boundary. `inputs`
    // are the values the task's prose names, appended to it as text: more of
    // the same argument, never a path, a tool or a host. `maxTurns` bounds the
    // harness further — the flag comes from the profile, and a harness with no
    // such flag refuses the budget rather than reaching anything new for it.
    // `model` names a model in the harness's own vocabulary, substituted into the
    // profile's own argument; it reaches no host this profile did not already
    // permit, and a profile with no such argument refuses it. `base` names a
    // commit the connected folder already holds, resolved by the machine; it
    // chooses where the checkout starts, never what the harness may reach.
    // `mergeFrom` names a branch on one of the folder's own remotes, fetched and
    // merged by the machine before the harness runs; it chooses what the
    // checkout holds, never what the harness may reach.
    const fields = [...harnessInput.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
    expect(fields).toEqual([
      'bindingId',
      'harness',
      'task',
      'inputs',
      'outputSchema',
      'resultRetries',
      'base',
      'mergeFrom',
      'continueFrom',
      'maxTurns',
      'model',
      'timeoutMs',
    ]);
  });

  it('parses a profile out of the machine policy, so pairing can write one', () => {
    const parsed = HostPolicySchema.parse({
      version: 1,
      bindings: [],
      harnesses: [{ id: 'claude', executable: 'claude', allowedDomains: ['api.anthropic.com'] }],
    });
    expect(parsed.harnesses[0]?.id).toBe('claude');
  });

  it('treats a policy with no harnesses as a machine that runs none', () => {
    expect(HostPolicySchema.parse({ version: 1, bindings: [] }).harnesses).toEqual([]);
  });

  it('ships no compiled-in domain list for any named harness', () => {
    // A domain list written from memory is a constant nobody measured. The
    // boundary refuses, the refusal names the host, the operator adds it.
    const defaults = HarnessProfileSchema.parse({ id: 'claude', executable: 'claude' });
    expect(defaults.allowedDomains).toEqual([]);
    expect(defaults.authPaths).toEqual([]);
    for (const file of sourceFiles(SRC)) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/api\.anthropic\.com|statsig\./);
    }
  });
});

describe('one spawn path', () => {
  it('nothing but sandboxedRun spawns a process', () => {
    // Commands and harnesses are confined, supervised and stopped by the same
    // code. A second spawn site would mean a fix to the group-kill or the
    // output cap silently missed one of them.
    // Importing child_process for a value is the honest signal: matching call
    // sites catches `regex.exec` and misses `promisify(execFile)`. A type-only
    // import is excluded — it cannot start anything, and counting it would push
    // a module that correctly delegates its spawning onto this list.
    const importers = sourceFiles(SRC)
      .filter((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .some(
            (line) =>
              line.includes("from 'node:child_process'") && !/^import\s+type\s/.test(line.trim()),
          ),
      )
      .map((file) => file.slice(SRC.length))
      .sort();
    // Six modules run something outside the boundary, each for a stated reason,
    // and none of them runs a workload: worktree.ts drives git, runtimes.ts and
    // harnessDiscovery.ts probe what is installed, credentialFetch.ts reaches
    // the credential store the boundary cannot, orphans.ts asks `ps` whether a
    // recorded pid still names the process it was recorded for — the
    // alternative being to kill by a number the operating system has since
    // given to somebody else — and folderPicker.ts asks `osascript` to show the
    // operator a folder chooser, which runs before any binding exists, in a
    // setup command rather than in a job, and service.ts drives `launchctl` to
    // install the launch agent that keeps this executor running — also a setup
    // command, and the operator's own login session rather than any workload.
    // Named rather than matched, so a new unconfined spawn is argued for here.
    expect(importers).toEqual([
      'credentialFetch.ts',
      'folderPicker.ts',
      'harnessDiscovery.ts',
      'orphans.ts',
      'runtimes.ts',
      'sandboxedRun.ts',
      'service.ts',
      'worktree.ts',
    ]);
  });

  it('the home region a harness reads around is the real one', () => {
    const policy = compileSandboxPolicy(binding, { scratchDir: '/tmp/s' });
    expect(policy.filesystem.denyRead).toContain(homedir());
  });
});

describe('what the home carve-outs actually expose', () => {
  /** Longest matching rule wins, which is how a deny-region-plus-allow policy resolves. */
  function readable(policy: ReturnType<typeof compileSandboxPolicy>, path: string): boolean {
    const longest = (rules: readonly string[]): number =>
      rules
        .filter((r) => path === r || path.startsWith(`${r}/`))
        .reduce((m, r) => (r.length > m ? r.length : m), -1);
    return longest(policy.filesystem.allowRead) > longest(policy.filesystem.denyRead);
  }

  const home = '/Users/op';
  const policy = (): ReturnType<typeof compileSandboxPolicy> =>
    compileSandboxPolicy(
      HostBindingSchema.parse({
        id: 'hb',
        root: '/Users/op/proj',
        mode: 'read',
        allowsExecution: true,
      }),
      { home, scratchDir: '/tmp/s' },
    );

  it('does not expose a credential store to reach a toolchain', () => {
    // The list once carried `.cache`, `.npm` and `.gitconfig` on the stated
    // reasoning that they hold "caches and version managers, not secrets".
    // Each of these sits inside one of them.
    const p = policy();
    expect(readable(p, `${home}/.cache/huggingface/token`)).toBe(false);
    expect(readable(p, `${home}/.npm/_cacache`)).toBe(false);
    expect(readable(p, `${home}/.gitconfig`)).toBe(false);
    expect(readable(p, `${home}/.cargo/credentials.toml`)).toBe(false);
    expect(readable(p, `${home}/.cargo/credentials`)).toBe(false);
  });

  it('still lets a version-managed interpreter run', () => {
    // Withholding these breaks every interpreter in turn, which is the failure
    // that makes people switch the sandbox off.
    const p = policy();
    expect(readable(p, `${home}/.nvm/versions/node/v22/bin/node`)).toBe(true);
    expect(readable(p, `${home}/.pyenv/versions/3.12/bin/python`)).toBe(true);
    expect(readable(p, `${home}/.rustup/toolchains/stable/bin/rustc`)).toBe(true);
    expect(readable(p, `${home}/.cargo/registry`)).toBe(true);
  });

  it('leaves the rest of home denied', () => {
    const p = policy();
    expect(readable(p, `${home}/.ssh/id_rsa`)).toBe(false);
    expect(readable(p, `${home}/.aws/credentials`)).toBe(false);
    expect(readable(p, `${home}/Documents/taxes.pdf`)).toBe(false);
  });
});
