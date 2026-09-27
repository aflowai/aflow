/**
 * Escapes and leaks a review found in the first cut of this lane. Each test
 * names the way out it closes.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostBindingError, HostBindingSchema, resolveWithin } from '../bindings.js';
import { buildBaseEnv } from '../baseEnv.js';
import { createStreamScrubber } from '../credentialFetch.js';
import { assertSafeEnv, EnvPolicyError } from '../envPolicy.js';
import { createHostFileHandler } from '../handlers/fileHandlers.js';
import { compileSandboxPolicy } from '../sandboxPolicy.js';

const run = promisify(execFile);

describe('the sandbox launcher is not steerable from a job', () => {
  it('refuses NODE_OPTIONS, which runs code before the sandbox exists', () => {
    // `spawn(node, [srt-cli, …])` boots a plain Node process first, and Node
    // reads NODE_OPTIONS at boot. `--require /path/x.js` therefore executed as
    // the operator, unconfined, without the command doing anything at all.
    expect(() => {
      assertSafeEnv({ NODE_OPTIONS: '--require /tmp/x.js' });
    }).toThrow(EnvPolicyError);
  });

  it('refuses the loader variables, which are the same hole by another name', () => {
    for (const name of ['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_EXTRA_CA_CERTS']) {
      expect(() => {
        assertSafeEnv({ [name]: '/tmp/x' });
      }).toThrow(EnvPolicyError);
    }
  });

  it('refuses the variables that steer where egress goes', () => {
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'PATH']) {
      expect(() => {
        assertSafeEnv({ [name]: 'x' });
      }).toThrow(EnvPolicyError);
    }
  });

  it('refuses the debug channel a run reads its own refusals from', () => {
    expect(() => {
      assertSafeEnv({ SRT_DEBUG: '1' });
    }).toThrow(EnvPolicyError);
  });

  it('is case-insensitive, since the risk does not fold case', () => {
    expect(() => {
      assertSafeEnv({ node_options: '--require /tmp/x.js' });
    }).toThrow(EnvPolicyError);
  });

  it('names every refused variable rather than the first', () => {
    try {
      assertSafeEnv({ NODE_OPTIONS: 'a', LD_PRELOAD: 'b', API_KEY: 'fine' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('LD_PRELOAD');
      expect((error as Error).message).toContain('NODE_OPTIONS');
      expect((error as Error).message).not.toContain('API_KEY');
    }
  });

  it('still passes what a workload legitimately needs', () => {
    expect(() => {
      assertSafeEnv({ API_KEY: 'k', DATABASE_URL: 'u', CI: 'true', RUST_LOG: 'debug' });
    }).not.toThrow();
  });
});

describe('a credential does not reach the live stream', () => {
  const secret = 'sk-ant-0123456789abcdef';

  it('redacts a credential that arrives whole', () => {
    const scrubber = createStreamScrubber(secret);
    const out = scrubber.push(`auth failed for ${secret} sorry`) + scrubber.flush();
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('redacts a credential split across two chunks, which per-chunk scrubbing misses', () => {
    const scrubber = createStreamScrubber(secret);
    const half = Math.floor(secret.length / 2);
    let out = scrubber.push(`before ${secret.slice(0, half)}`);
    out += scrubber.push(`${secret.slice(half)} after`);
    out += scrubber.flush();
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('redacts a credential split one character at a time', () => {
    const scrubber = createStreamScrubber(secret);
    let out = '';
    for (const char of `x${secret}y`) out += scrubber.push(char);
    out += scrubber.flush();
    expect(out).not.toContain(secret);
    expect(out).toBe('x[redacted]y');
  });

  it('loses nothing when there is no credential', () => {
    const scrubber = createStreamScrubber(undefined);
    expect(scrubber.push('abc') + scrubber.flush()).toBe('abc');
  });

  it('emits every byte of ordinary output, held back or not', () => {
    const scrubber = createStreamScrubber(secret);
    const chunks = ['hello ', 'world ', 'again'];
    let out = '';
    for (const chunk of chunks) out += scrubber.push(chunk);
    out += scrubber.flush();
    expect(out).toBe(chunks.join(''));
  });
});

describe('a repository .git is not reachable content', () => {
  let root: string;
  let binding: ReturnType<typeof HostBindingSchema.parse>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aflow-git-'));
    await run('git', ['-C', root, 'init', '--initial-branch=main']);
    binding = HostBindingSchema.parse({ id: 'hb', root, mode: 'readwrite', allowsExecution: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses .git/config, whose filters git runs as the operator on checkout', async () => {
    // Writing a `filter.*.smudge` command there turns the next coding run into
    // arbitrary code execution outside the sandbox.
    await expect(resolveWithin(binding, '.git/config', false)).rejects.toThrow(HostBindingError);
  });

  it('refuses a hook, which runs on the checkout a coding run makes', async () => {
    await expect(resolveWithin(binding, '.git/hooks/post-checkout', false)).rejects.toThrow(
      /\.git/,
    );
  });

  it('refuses .git itself and anything under it, at any depth', async () => {
    for (const path of ['.git', '.git/objects', 'sub/.git/config']) {
      await expect(resolveWithin(binding, path, false)).rejects.toThrow(HostBindingError);
    }
  });

  it('still reaches ordinary files, including ones merely named like it', async () => {
    await writeFile(join(root, 'gitignore-notes.md'), 'fine\n');
    await expect(resolveWithin(binding, 'gitignore-notes.md', true)).resolves.toContain(
      'gitignore-notes.md',
    );
  });
});

describe('a harness does not inherit the write grant git needed', () => {
  it('withholds the binding root even from a writable binding', () => {
    // The binding must be writable because creating a worktree records it under
    // the repository's own .git. The harness works in the worktree and never
    // needs that permission, so its policy does not carry it.
    const binding = HostBindingSchema.parse({
      id: 'hb',
      root: '/Users/op/project',
      mode: 'readwrite',
      allowsExecution: true,
    });
    const policy = compileSandboxPolicy(binding, {
      home: '/Users/op',
      scratchDir: '/tmp/s',
      widening: {
        authPaths: [],
        allowedDomains: [],
        writableRoot: '/tmp/s/work',
        withholdBindingWrite: true,
      },
    });
    expect(policy.filesystem.allowWrite).not.toContain('/Users/op/project');
    expect(policy.filesystem.allowWrite).toContain('/tmp/s/work');
    // Still readable — the harness has to see the code it is changing.
    expect(policy.filesystem.allowRead).toContain('/Users/op/project');
  });

  it('leaves an ordinary command its binding write grant', () => {
    const binding = HostBindingSchema.parse({
      id: 'hb',
      root: '/Users/op/project',
      mode: 'readwrite',
      allowsExecution: true,
    });
    const policy = compileSandboxPolicy(binding, { home: '/Users/op', scratchDir: '/tmp/s' });
    expect(policy.filesystem.allowWrite).toContain('/Users/op/project');
  });
});

describe('an environment variable is the name the operating system reads back', () => {
  it('refuses a key containing =, which smuggles a denied name past a whole-key check', () => {
    // The environment is NAME=VALUE split on the FIRST `=`, so this key reaches
    // the child as the variable HTTPS_PROXY — and a deny list comparing whole
    // keys never sees it. The launcher's own proxy reads exactly that variable,
    // so every sandboxed connection, credential-bearing ones included, could be
    // redirected through a host of the job's choosing.
    expect(() => {
      assertSafeEnv({ 'HTTPS_PROXY=http://198.51.100.9:8080/': 'x' });
    }).toThrow(EnvPolicyError);
    expect(() => {
      assertSafeEnv({ 'NODE_OPTIONS=--require /tmp/x.js': 'y' });
    }).toThrow(EnvPolicyError);
  });

  it('refuses names that are not names — whitespace, newlines, lookalikes', () => {
    for (const name of [
      'FOO BAR',
      `FOO${String.fromCharCode(10)}HTTPS_PROXY`,
      '\u0420\u0410TH',
      '9LEADING',
      '',
    ]) {
      expect(() => {
        assertSafeEnv({ [name]: 'x' });
      }).toThrow(EnvPolicyError);
    }
  });

  it('refuses TMPDIR, which steers the unconfined launcher own scratch', () => {
    expect(() => {
      assertSafeEnv({ TMPDIR: '/tmp/attacker' });
    }).toThrow(EnvPolicyError);
  });

  it('still accepts ordinary names', () => {
    expect(() => {
      assertSafeEnv({ API_KEY: 'k', _PRIVATE: '1', RUST_LOG: 'debug' });
    }).not.toThrow();
  });
});

describe('a credential survives neither stream interleaving nor truncation', () => {
  const secret = 'sk-ant-0123456789abcdefghij';

  it('does not reassemble across two streams sharing a scrubber', () => {
    // One scrubber for both streams let a chunk of stderr flush the tail stdout
    // was holding, publishing the token in two pieces.
    const out = createStreamScrubber(secret);
    const err = createStreamScrubber(secret);
    let published = '';
    published += out.push(`auth fail`);
    published += out.push(`ed with key ${secret.slice(0, 12)}`);
    published += err.push('warn: retrying\n');
    published += out.push(`${secret.slice(12)} and gave up\n`);
    published += out.flush();
    published += err.flush();
    expect(published).not.toContain(secret);
    expect(published).not.toContain(secret.slice(0, 20));
  });

  it('redacts a partial credential left held when output stops mid-token', () => {
    // A cap truncating the stream, or a killed process, leaves the carry as a
    // proper prefix of the secret. Releasing it verbatim publishes most of it.
    const scrubber = createStreamScrubber(secret);
    scrubber.push(`key ${secret.slice(0, secret.length - 3)}`);
    const flushed = scrubber.flush();
    expect(flushed).not.toContain(secret.slice(0, 12));
    expect(flushed).toContain('[redacted]');
  });

  it('does not redact ordinary text that merely ends mid-word', () => {
    const scrubber = createStreamScrubber(secret);
    scrubber.push('all done, nothing to hide');
    expect(scrubber.flush()).not.toContain('[redacted]');
  });
});

describe('the .git refusal judges where a path lands', () => {
  let root: string;
  let binding: ReturnType<typeof HostBindingSchema.parse>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aflow-gitland-'));
    await run('git', ['-C', root, 'init', '--initial-branch=main']);
    await symlink(join(root, '.git'), join(root, 'peek'));
    binding = HostBindingSchema.parse({ id: 'hb', root, mode: 'readwrite', allowsExecution: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a case-folded spelling, which macOS resolves to the same file', async () => {
    for (const spelling of ['.GIT/config', '.Git/config', '.git/CONFIG']) {
      await expect(resolveWithin(binding, spelling, false)).rejects.toThrow(HostBindingError);
    }
  });

  it('refuses a symlink pointing into .git, for reads and for creates alike', async () => {
    await expect(resolveWithin(binding, 'peek/config', false)).rejects.toThrow(HostBindingError);
    await expect(resolveWithin(binding, 'peek/hooks/post-checkout', false)).rejects.toThrow(
      HostBindingError,
    );
  });
});

describe('the executor own credentials do not travel into a workload', () => {
  it('withholds what pairing put in the executor environment', () => {
    // Pairing writes REDIS_URL — password and all — into the file the executor
    // is started from, and PHOENIX_INSTANCE_SECRET sits beside it. Passing the
    // environment through wholesale meant `env` inside a confined command
    // printed both, and a harness, which has egress, could send them on.
    const source = {
      REDIS_URL: 'redis://hostexec:SECRET@127.0.0.1:6379',
      PHOENIX_INSTANCE_SECRET: 'instance-secret',
      AFLOW_API_URL: 'http://127.0.0.1:3000',
      PATH: '/usr/bin',
      HOME: '/Users/op',
    };
    const built = buildBaseEnv('/tmp/scratch', [], source);
    expect(built).not.toHaveProperty('REDIS_URL');
    expect(built).not.toHaveProperty('PHOENIX_INSTANCE_SECRET');
    expect(built).not.toHaveProperty('AFLOW_API_URL');
    expect(JSON.stringify(built)).not.toContain('SECRET');
  });

  it('is an allow list, so a secret added to the executor later is absent too', () => {
    const built = buildBaseEnv('/tmp/scratch', [], {
      PATH: '/usr/bin',
      SOME_FUTURE_TOKEN: 'whatever-comes-next',
    });
    expect(built).not.toHaveProperty('SOME_FUTURE_TOKEN');
  });

  it('still carries a working shell and the operator toolchain roots', () => {
    // A command that cannot find the operator's node or their virtualenv is
    // not worth confining, so withholding these would defeat the lane.
    const source = {
      PATH: '/usr/bin',
      HOME: '/Users/op',
      LANG: 'en_US.UTF-8',
      NVM_DIR: '/Users/op/.nvm',
      VIRTUAL_ENV: '/Users/op/proj/.venv',
      CARGO_HOME: '/Users/op/.cargo',
    };
    const built = buildBaseEnv('/tmp/scratch', [], source);
    for (const name of Object.keys(source)) {
      // HOME is the exception, and it has its own test below.
      if (name === 'HOME') continue;
      expect(built[name]).toBe(source[name as keyof typeof source]);
    }
  });

  it('points TMPDIR at the run own scratch rather than inheriting the host one', () => {
    const built = buildBaseEnv('/tmp/run-scratch', [], { TMPDIR: '/somewhere/else' });
    expect(built['TMPDIR']).toBe('/tmp/run-scratch');
  });

  it('gives the workload a home it may read, not the one that is denied', () => {
    // Home is denied as a region, so passing the operator's through named a
    // place the workload would be refused — and almost every tool opens
    // something under it before doing any work. `git log` never reached the
    // repository: it read `~/.gitconfig`, got EPERM and exited 128. The same
    // waits for ssh, npm, pip and anything else with a dotfile.
    const built = buildBaseEnv('/tmp/run-scratch', [], { HOME: '/Users/op' });
    expect(built['HOME']).toBe('/tmp/run-scratch/home');
    expect(built['HOME']).not.toContain('/Users/op');
  });

  it('leaves the toolchain roots alone, since those regions are carved out', () => {
    // `CARGO_HOME` and friends point under the real home and stay that way:
    // the sandbox allows those paths specifically, so redirecting them would
    // break the toolchains this lane exists to reach.
    const built = buildBaseEnv('/tmp/run-scratch', [], {
      HOME: '/Users/op',
      CARGO_HOME: '/Users/op/.cargo',
      NVM_DIR: '/Users/op/.nvm',
    });
    expect(built['CARGO_HOME']).toBe('/Users/op/.cargo');
    expect(built['NVM_DIR']).toBe('/Users/op/.nvm');
  });

  it('lets the machine policy name extra variables to inherit', () => {
    const built = buildBaseEnv('/tmp/s', ['MY_BUILD_FLAG'], {
      MY_BUILD_FLAG: 'on',
      MY_OTHER: 'off',
    });
    expect(built['MY_BUILD_FLAG']).toBe('on');
    expect(built).not.toHaveProperty('MY_OTHER');
  });
});

describe('a verified path is not re-resolved at the moment of use', () => {
  it('refuses a read whose final component became a symlink after the check', async () => {
    // `resolveWithin` checks a pathname; the read happens later, unsandboxed.
    // Between the two, anything that can write in the binding can swap the file
    // for a link and redirect the read outside it.
    const base = await mkdtemp(join(tmpdir(), 'aflow-toctou-'));
    const root = join(base, 'project');
    const outside = join(base, 'outside.txt');
    await mkdir(root, { recursive: true });
    await writeFile(outside, 'CONTENT OUTSIDE THE BINDING');

    const policyPath = join(base, 'p.json');
    await writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            id: 'hb',
            root,
            mode: 'readwrite',
            allowsExecution: false,
            singleFile: false,
            spaceId: 'space-test',
          },
        ],
      }),
    );

    // The swap: a name inside the binding that is really a link out of it.
    await symlink(outside, join(root, 'innocent.txt'));

    const captured: { output?: Record<string, unknown> } = {};
    const ctx = {
      operationId: 'host.file.get',
      spaceId: 'space-test',
      runId: 'run-a',
      stepExecutionId: 'step-1',
      job: { inputRef: 'inline:x' },
      signal: new AbortController().signal,
      log: { error: () => undefined, warn: () => undefined, info: () => undefined },
      readPayload: () => Promise.resolve({ bindingId: 'hb', path: 'innocent.txt' }),
      emitLiveDelta: () => Promise.resolve(),
      writePayload: (_k: string, d: unknown) => {
        captured.output = d as Record<string, unknown>;
        return Promise.resolve('inline:out');
      },
    } as never;

    const result = await createHostFileHandler(policyPath).execute(ctx);
    expect(result.status).toBe('FAILED');
    expect(JSON.stringify(captured.output ?? {})).not.toContain('CONTENT OUTSIDE');
    await rm(base, { recursive: true, force: true });
  });

  it('refuses a write whose final component became a symlink after the check', async () => {
    // The same swap, in the more consequential direction: reading through a
    // planted link discloses a file, writing through one replaces it.
    const base = await mkdtemp(join(tmpdir(), 'aflow-toctou-w-'));
    const root = join(base, 'project');
    const outside = join(base, 'precious.txt');
    await mkdir(root, { recursive: true });
    await writeFile(outside, 'ORIGINAL');

    const policyPath = join(base, 'p.json');
    await writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            id: 'hb',
            root,
            mode: 'readwrite',
            allowsExecution: false,
            singleFile: false,
            spaceId: 'space-test',
          },
        ],
      }),
    );
    await symlink(outside, join(root, 'innocent.txt'));

    const ctx = {
      operationId: 'host.file.put',
      spaceId: 'space-test',
      runId: 'run-a',
      stepExecutionId: 'step-1',
      job: { inputRef: 'inline:x' },
      signal: new AbortController().signal,
      log: { error: () => undefined, warn: () => undefined, info: () => undefined },
      readPayload: () =>
        Promise.resolve({
          bindingId: 'hb',
          path: 'innocent.txt',
          content: 'OVERWRITTEN',
          encoding: 'utf8',
        }),
      emitLiveDelta: () => Promise.resolve(),
      writePayload: () => Promise.resolve('inline:out'),
    } as never;

    const { createHostFileHandler } = await import('../handlers/fileHandlers.js');
    const result = await createHostFileHandler(policyPath).execute(ctx);
    expect(result.status).toBe('FAILED');
    expect(await readFile(outside, 'utf8')).toBe('ORIGINAL');
    await rm(base, { recursive: true, force: true });
  });
});
