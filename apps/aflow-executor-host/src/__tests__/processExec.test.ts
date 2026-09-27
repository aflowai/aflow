/**
 * Contract: a command runs confined, or it does not run.
 *
 * Exercises the real spawn path — the adapter binary, the compiled policy, the
 * process group — rather than asserting that an argv array contains a flag.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, beforeAll } from 'vitest';

import { createHostProcessHandler } from '../handlers/processHandlers.js';
import { sandboxReadiness } from '../sandboxedRun.js';

const execFileAsync = promisify(execFile);

let policyPath: string;
let root: string;
let outside: string;

interface Captured {
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
  /** Live deltas, for the tests that care what the step narrated. */
  deltas?: string[];
}

/** Enough ExecutorContext for the process half, which uses very little of it. */
function contextFor(operationId: string, input: unknown, captured: Captured): never {
  return {
    operationId,
    spaceId: 'space-test',
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () => Promise.resolve(input),
    emitLiveDelta: (_channel: string, delta: string) => {
      captured.deltas?.push(delta);
      return Promise.resolve();
    },
    writePayload: (_kind: string, data: unknown) => {
      captured.output = data as Record<string, unknown>;
      return Promise.resolve('inline:out');
    },
  } as never;
}

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'host-proc-'));
  root = join(base, 'project');
  outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.txt'), 'classified');
  policyPath = join(base, 'host-policy.json');
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [
        {
          id: 'hb',
          root,
          mode: 'readwrite',
          allowsExecution: true,
          singleFile: false,
          spaceId: 'space-test',
        },
        // Connected for its files, and nothing else.
        {
          id: 'hb_files',
          root,
          mode: 'readwrite',
          allowsExecution: false,
          singleFile: false,
          spaceId: 'space-test',
        },
      ],
    }),
  );
});

/**
 * Suites below that start a real confined process run only where this machine
 * can actually confine one. `isSupportedPlatform` is not that question: on
 * Linux it is true whether or not `bwrap`, `rg` and `socat` are installed, and
 * CI has none of them — the suite failed there reporting a dependency error as
 * though it were the command's own output.
 *
 * Only the suites that spawn are gated. The ones that refuse before spawning,
 * and the ones that are pure schema, are the coverage Linux most needs to keep.
 */
const CAN_CONFINE = sandboxReadiness().ready;

describe.runIf(CAN_CONFINE)('host process execution', () => {
  it('runs a command inside the binding', async () => {
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath);
    await handler.execute(
      contextFor('host.process.exec', { bindingId: 'hb', command: ['echo', 'hello'] }, captured),
    );
    expect(captured.output?.['exitCode']).toBe(0);
    expect(String(captured.output?.['stdout'])).toContain('hello');
    // The result says how it ran. Everything but a permitted push is confined,
    // and a reader of the step should not have to infer which it got.
    expect(captured.output?.['confined']).toBe(true);
  }, 60_000);

  it('denies the command what lives under the operator home', async () => {
    // The property that matters: keys, cloud credentials, browser profiles and
    // this executor's own pairing state all live under home, and the policy
    // denies that region wholesale.
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath);
    await handler.execute(
      contextFor(
        'host.process.exec',
        { bindingId: 'hb', command: ['cat', join(homedir(), '.ssh', 'known_hosts')] },
        captured,
      ),
    );
    expect(captured.output?.['exitCode']).not.toBe(0);
  }, 60_000);

  it('does NOT confine reads outside home, which is the disclosed limitation', async () => {
    // Not a bug and not an oversight: the adapter permits reads by default and
    // narrows by denial, so there is no allow-list to write. `/usr`, `/opt` and
    // anything else outside home stays readable, and what keeps its contents on
    // the machine is the egress policy rather than the read policy. This test
    // exists so the property is asserted rather than discovered.
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath);
    await handler.execute(
      contextFor(
        'host.process.exec',
        { bindingId: 'hb', command: ['cat', join(outside, 'secret.txt')] },
        captured,
      ),
    );
    expect(captured.output?.['exitCode']).toBe(0);
  }, 60_000);

  it('refuses a command in a binding that only carries files', async () => {
    // The machine's own ceiling, checked before a policy is compiled or a
    // process is spawned. An appliance asking for a shell in a folder the
    // operator connected for reading is refused by a file it cannot write.
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath);
    const result = await handler.execute(
      contextFor(
        'host.process.exec',
        { bindingId: 'hb_files', command: ['echo', 'should-not-run'] },
        captured,
      ),
    );
    expect(result.status).toBe('FAILED');
    // The refusal is a permission answer, and nothing ran: a process result
    // would carry an exit code, and this carries an error code instead.
    expect(captured.output?.['code']).toBe('PERMISSION_DENIED');
    expect(captured.output?.['exitCode']).toBeUndefined();
  }, 30_000);

  it('refuses to inspect processes in a files-only binding', async () => {
    // Answering would say which process ids exist, which is information a
    // binding without execution has no business carrying.
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath);
    const result = await handler.execute(
      contextFor('host.process.inspect', { bindingId: 'hb_files', processId: 'hp_x' }, captured),
    );
    expect(result.status).toBe('FAILED');
  }, 30_000);

  it('refuses an unknown binding rather than running anything', async () => {
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath);
    const result = await handler.execute(
      contextFor('host.process.exec', { bindingId: 'nope', command: ['echo', 'x'] }, captured),
    );
    expect(result.status).toBe('FAILED');
  }, 30_000);

  it('refuses an env that would run code before the sandbox is installed', async () => {
    // The spawned process is a plain Node process until the adapter's CLI
    // installs the boundary, and Node reads NODE_OPTIONS at boot.
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath);
    const result = await handler.execute(
      contextFor(
        'host.process.exec',
        {
          bindingId: 'hb',
          command: ['echo', 'x'],
          env: { NODE_OPTIONS: '--require /tmp/anything.js' },
        },
        captured,
      ),
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.message ?? '').toContain('NODE_OPTIONS');
    // Retrying with the same environment fails identically, so this is not a
    // transient the orchestrator should keep trying.
    expect(result.error?.retryable).toBe(false);
  }, 30_000);

  it('refuses a working directory outside the binding', async () => {
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath);
    const result = await handler.execute(
      contextFor(
        'host.process.exec',
        { bindingId: 'hb', command: ['pwd'], cwd: '../outside' },
        captured,
      ),
    );
    expect(result.status).toBe('FAILED');
  }, 30_000);

  it('runs in the binding root when no working directory is given', async () => {
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath);
    const result = await handler.execute(
      contextFor('host.process.exec', { bindingId: 'hb', command: ['pwd'] }, captured),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(String(captured.output?.['stdout'] ?? '')).toContain('project');
  }, 30_000);

  it('narrates what the command said on standard error', async () => {
    // Where a command's progress usually speaks. Withheld, a build that logs
    // steadily and prints nothing at the end looks like a step doing nothing.
    const captured: Captured = { deltas: [] };
    const handler = createHostProcessHandler(policyPath);
    await handler.execute(
      contextFor(
        'host.process.exec',
        { bindingId: 'hb', command: ['/bin/sh', '-c', 'echo compiling-something 1>&2'] },
        captured,
      ),
    );
    expect((captured.deltas ?? []).join('')).toContain('compiling-something');
  }, 60_000);

  it('answers `exited` for a run that finished, not `unknown`', async () => {
    // `unknown` is the answer that means this executor cannot tell — deleting
    // the handle on exit made every completed run indistinguishable from one
    // lost to a restart.
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath);
    await handler.execute(
      contextFor('host.process.exec', { bindingId: 'hb', command: ['echo', 'done'] }, captured),
    );
    const processId = String(captured.output?.['processId'] ?? '');
    expect(processId).not.toBe('');

    const inspected: Captured = {};
    const result = await handler.execute(
      contextFor('host.process.inspect', { bindingId: 'hb', processId }, inspected),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(inspected.output?.['state']).toBe('exited');
    expect(inspected.output?.['exitCode']).toBe(0);
  }, 30_000);
});

/**
 * The push rule, through the handler rather than through the function it calls:
 * what matters is that a refused push never reaches a spawn, that an allowed one
 * does, and that the allowed one runs as the operator's own git rather than
 * inside the sandbox — whose egress is an authenticating HTTP proxy no git
 * transport but HTTP(S) can speak to.
 */
describe('a push runs only where the folder allows one', () => {
  let pushBase: string;
  let repo: string;
  let pushPolicyPath: string;

  beforeAll(async () => {
    pushBase = await mkdtemp(join(tmpdir(), 'host-push-'));
    repo = join(pushBase, 'repo');
    await mkdir(repo, { recursive: true });
    await execFileAsync('git', ['init', '-q', '--initial-branch=main', repo]);
    await execFileAsync('git', ['-C', repo, 'config', 'user.email', 't@e.com']);
    await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'T']);
    await writeFile(join(repo, 'a.txt'), 'one\n');
    await execFileAsync('git', ['-C', repo, 'add', '-A']);
    await execFileAsync('git', ['-C', repo, 'commit', '-q', '-m', 'initial']);
    await execFileAsync('git', ['-C', repo, 'branch', 'aflow/ready']);
    // A remote inside the folder, so the push is a real one and still lands
    // where the boundary allows a write.
    await execFileAsync('git', ['init', '-q', '--bare', join(repo, 'remote.git')]);

    pushPolicyPath = join(pushBase, 'host-policy.json');
    await writeFile(
      pushPolicyPath,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            id: 'hb_push',
            root: repo,
            mode: 'readwrite',
            allowsExecution: true,
            branchPolicy: { branchPrefix: 'aflow/' },
            singleFile: false,
            spaceId: 'space-test',
          },
          {
            id: 'hb_nopush',
            root: repo,
            mode: 'readwrite',
            allowsExecution: true,
            singleFile: false,
            spaceId: 'space-test',
          },
        ],
      }),
    );
  });

  it('refuses a force before anything is spawned', async () => {
    const captured: Captured = {};
    const result = await createHostProcessHandler(pushPolicyPath).execute(
      contextFor(
        'host.process.exec',
        {
          bindingId: 'hb_push',
          command: ['git', 'push', '--force', './remote.git', 'aflow/ready'],
        },
        captured,
      ),
    );
    expect(result.status).toBe('FAILED');
    // A permission answer rather than a process result: nothing ran, so there
    // is no exit code to report.
    expect(captured.output?.['code']).toBe('PERMISSION_DENIED');
    expect(captured.output?.['exitCode']).toBeUndefined();
    // The remote is still empty, which is the property behind the assertion.
    const refs = await execFileAsync('git', ['-C', join(repo, 'remote.git'), 'branch', '--list']);
    expect(refs.stdout.trim()).toBe('');
  }, 30_000);

  it('refuses any push from a folder that declared no prefix', async () => {
    const captured: Captured = {};
    const result = await createHostProcessHandler(pushPolicyPath).execute(
      contextFor(
        'host.process.exec',
        { bindingId: 'hb_nopush', command: ['git', 'push', './remote.git', 'aflow/ready'] },
        captured,
      ),
    );
    expect(result.status).toBe('FAILED');
    expect(captured.output?.['code']).toBe('PERMISSION_DENIED');
  }, 30_000);

  it('refuses a push carrying a git global option', async () => {
    // Nothing stands before `push`: a push runs unconfined, so an option that
    // names a config source, a program or another repository is the job choosing
    // what runs as the operator.
    const captured: Captured = {};
    const result = await createHostProcessHandler(pushPolicyPath).execute(
      contextFor(
        'host.process.exec',
        {
          bindingId: 'hb_push',
          command: ['git', '-c', 'core.sshCommand=/tmp/x', 'push', './remote.git', 'aflow/ready'],
        },
        captured,
      ),
    );
    expect(result.status).toBe('FAILED');
    expect(captured.output?.['code']).toBe('PERMISSION_DENIED');
    expect(captured.output?.['exitCode']).toBeUndefined();
    const refs = await execFileAsync('git', ['-C', join(repo, 'remote.git'), 'branch', '--list']);
    expect(refs.stdout.trim()).toBe('');
  }, 30_000);

  it('refuses a push carrying an environment of its own', async () => {
    // The environment a push runs in is the operator's, so a job cannot add to
    // it — `GIT_SSH_COMMAND` there would be a program of the job's choosing.
    const captured: Captured = {};
    const result = await createHostProcessHandler(pushPolicyPath).execute(
      contextFor(
        'host.process.exec',
        {
          bindingId: 'hb_push',
          command: ['git', 'push', './remote.git', 'aflow/ready'],
          env: { GIT_SSH_COMMAND: '/tmp/anything' },
        },
        captured,
      ),
    );
    expect(result.status).toBe('FAILED');
    expect(captured.output?.['code']).toBe('PERMISSION_DENIED');
    const refs = await execFileAsync('git', ['-C', join(repo, 'remote.git'), 'branch', '--list']);
    expect(refs.stdout.trim()).toBe('');
  }, 30_000);

  it('lets a branch under the prefix through to the remote, as the operator’s own git', async () => {
    // Unconfined, which is why this needs no sandbox to run: the push that
    // failed in production passed the rule and then met the sandbox's proxy,
    // which git over SSH cannot authenticate to.
    const captured: Captured = {};
    const result = await createHostProcessHandler(pushPolicyPath).execute(
      contextFor(
        'host.process.exec',
        { bindingId: 'hb_push', command: ['git', 'push', './remote.git', 'aflow/ready'] },
        captured,
      ),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(captured.output?.['exitCode']).toBe(0);
    expect(captured.output?.['confined']).toBe(false);
    const refs = await execFileAsync('git', ['-C', join(repo, 'remote.git'), 'branch', '--list']);
    expect(refs.stdout).toContain('aflow/ready');
  }, 60_000);
});
