/**
 * Contract: an operator can say where their tools live, once, and commands can
 * then read them — without moving the program or opening their home.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostBindingSchema, HostPolicySchema } from '../bindings.js';
import { explainFailedStart } from '../executableHint.js';
import { compileSandboxPolicy } from '../sandboxPolicy.js';
import { runSandboxed, sandboxAvailable } from '../sandboxedRun.js';
import { CONFINEMENT_LISTENERS, requires } from './fixtures/capabilities.js';

const confined = requires(...CONFINEMENT_LISTENERS);

let fakeHome: string;
let toolDir: string;
let root: string;
let scratch: string;

const binding = (r: string) =>
  HostBindingSchema.parse({ id: 'hb', root: r, mode: 'readwrite', allowsExecution: true });

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), 'aflow-home-'));
  toolDir = join(fakeHome, '.local', 'bin');
  await mkdir(toolDir, { recursive: true });
  await writeFile(join(toolDir, 'mycli'), '#!/bin/sh\necho "mycli ran"\n');
  await chmod(join(toolDir, 'mycli'), 0o755);
  root = await mkdtemp(join(tmpdir(), 'aflow-proj-'));
  scratch = await mkdtemp(join(tmpdir(), 'aflow-scr-'));
});
afterEach(async () => {
  await rm(fakeHome, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

describe('declaring where tools live', () => {
  it('carves the named path out of the denied home region', () => {
    const policy = compileSandboxPolicy(binding(root), {
      home: fakeHome,
      scratchDir: scratch,
      toolPaths: [toolDir],
    });
    expect(policy.filesystem.allowRead).toContain(toolDir);
    // The region itself stays denied — this opens what was named, not home.
    expect(policy.filesystem.denyRead).toContain(fakeHome);
    expect(policy.filesystem.allowRead).not.toContain(fakeHome);
    // And read-only: naming where a tool lives does not make it writable.
    expect(policy.filesystem.allowWrite).not.toContain(toolDir);
  });

  it('grants nothing when nothing was named', () => {
    const policy = compileSandboxPolicy(binding(root), { home: fakeHome, scratchDir: scratch });
    expect(policy.filesystem.allowRead).not.toContain(toolDir);
  });

  it('the machine policy defaults to naming none', () => {
    expect(HostPolicySchema.parse({ version: 1, bindings: [] }).toolPaths).toEqual([]);
  });

  it.skipIf(!sandboxAvailable() || confined.skip)(
    confined.title('actually runs a command installed under home once it is named'),
    async () => {
      const exe = join(toolDir, 'mycli');
      const common = {
        binding: binding(root),
        argv: [exe],
        cwd: root,
        env: {},
        timeoutMs: 20_000,
        scratchDir: scratch,
        idPrefix: 't',
        ownerRunId: 'probe',
        signal: new AbortController().signal,
        onDelta: () => undefined,
      };

      // The real home is denied, and this fake one sits under the system temp
      // root, so the check that matters is the declaration itself: naming the
      // directory is what puts it in allowRead.
      const named = await runSandboxed({ ...common, toolPaths: [toolDir] });
      expect(named.exitCode).toBe(0);
      expect(named.stdout).toContain('mycli ran');
    },
    60_000,
  );
});

describe('a refusal that names its own cause', () => {
  it('explains an absolute path under home that was not named', () => {
    const note = explainFailedStart(
      ['/Users/op/.local/bin/mycli'],
      126,
      '/bin/sh: /Users/op/.local/bin/mycli: Operation not permitted',
      '/Users/op',
      [],
    );
    expect(note).toContain('home directory');
    expect(note).toContain('toolPaths');
  });

  it('says nothing once the path has been named', () => {
    const note = explainFailedStart(
      ['/Users/op/.local/bin/mycli'],
      126,
      'Operation not permitted',
      '/Users/op',
      ['/Users/op/.local/bin'],
    );
    expect(note).toBeUndefined();
  });

  it('says nothing for a program outside home', () => {
    expect(
      explainFailedStart(['/usr/local/bin/mycli'], 127, 'command not found', '/Users/op', []),
    ).toBeUndefined();
  });

  it('does not answer a wrong flag with advice about installation paths', () => {
    // Exit 2 with a usage message is the command working and disagreeing.
    expect(
      explainFailedStart(
        ['/Users/op/.local/bin/mycli'],
        2,
        'usage: mycli [--flag]',
        '/Users/op',
        [],
      ),
    ).toBeUndefined();
  });

  it('hedges for a bare name, which it cannot resolve from here', () => {
    const note = explainFailedStart(['mycli'], 127, 'command not found', '/Users/op', []);
    expect(note).toContain('toolPaths');
    expect(note).toContain('absolute path');
  });
});

describe('knowing whether this machine can confine anything', () => {
  it('reports what is missing, not merely that something is', async () => {
    // "Install these three packages" is the whole of what a Linux operator
    // needs, and the refusal is the only place they will see it.
    const { noSandboxMessage } = await import('../sandboxedRun.js');
    const message = noSandboxMessage([
      'ripgrep (rg) not found',
      'bubblewrap (bwrap) not installed',
    ]);
    expect(message).toContain('ripgrep');
    expect(message).toContain('bwrap');
    expect(message).toContain('unconfined');
  });

  it('says nothing extra when it has nothing to name', async () => {
    const { noSandboxMessage } = await import('../sandboxedRun.js');
    expect(noSandboxMessage([])).not.toContain('Missing:');
  });

  it('answers both questions, not just the platform one', async () => {
    // `isSupportedPlatform` is true on Linux whether or not bwrap, rg and socat
    // are installed. Asking only that let a machine that cannot confine spawn
    // anyway, and report a dependency error as the command's own failure.
    const { sandboxReadiness } = await import('../sandboxedRun.js');
    const readiness = sandboxReadiness();
    expect(typeof readiness.ready).toBe('boolean');
    expect(Array.isArray(readiness.missing)).toBe(true);
    // Ready and "nothing missing" are the same statement; they must not drift.
    expect(readiness.ready).toBe(readiness.missing.length === 0);
  });
});
