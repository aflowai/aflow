/**
 * Contract: a command runs confined, or it does not run.
 *
 * Exercises the real spawn path — the adapter binary, the compiled policy, the
 * process group — rather than asserting that an argv array contains a flag.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, beforeAll } from 'vitest';

import { hostPushRequestHash } from '@aflow/redis';
import type { HostPushApproval, WriteApprovalGrant } from '@aflow/schemas';

import { PUSH_REQUIRED_OPTIONS } from '../bindings.js';
import { createHostProcessHandler } from '../handlers/processHandlers.js';
import { RECEIPT_TTL_MS } from '../receiptSigning.js';
import { issueScanReceipt, type PushApprovalReader, type ScanOutcome } from '../scanReceipt.js';
import { noPushApprovals, pushApprovalsHolding } from './fixtures/pushApprovals.js';
import {
  confinedArgv,
  readWorkloadStatus,
  resolveConfinedExit,
  sandboxReadiness,
  statusWrappedArgv,
  workloadStatusPath,
} from '../sandboxedRun.js';

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

const TENANT = 'tenant-test';
const RUN = 'run-test';

/** Enough ExecutorContext for the process half, which uses very little of it. */
function contextFor(operationId: string, input: unknown, captured: Captured): never {
  return {
    operationId,
    tenantId: TENANT,
    spaceId: 'space-test',
    runId: RUN,
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

/**
 * Contract: the workload's own exit status is what is reported, and a broken
 * pipe is not a failure.
 *
 * The adapter's CLI collapses every signal death other than SIGINT and SIGTERM
 * into `exit 1` and names the signal only on its own standard error, so a
 * pipeline whose writer was killed by SIGPIPE — `head` having read enough —
 * reported a bare `1` that read exactly like a command failing on its own.
 *
 * That standard error is the workload's too (the launcher spawns it with
 * `stdio: 'inherit'`), so it is not where this is recovered from. The status
 * comes off a channel the workload's streams are not: a `sh` wrapper writes its
 * own `$?` to a file in the run's scratch, and this executor reads it back.
 */
describe('the exit status of a confined command', () => {
  it('reads a broken pipe as success, naming the signal', () => {
    // 141 is how every shell spells a SIGPIPE death: 128 + 13.
    expect(resolveConfinedExit(141, null, 141)).toEqual({ exitCode: 0, signal: 'SIGPIPE' });
  });

  it('leaves a command that failed on its own alone', () => {
    expect(resolveConfinedExit(3, null, 3)).toEqual({ exitCode: 3, signal: null });
    expect(resolveConfinedExit(0, null, 0)).toEqual({ exitCode: 0, signal: null });
  });

  it('keeps every other signal a failure, and now says which', () => {
    // A killed or crashed command still fails, with the status the shell gives
    // it — 128 + the signal — and now the signal's name as well.
    expect(resolveConfinedExit(1, null, 137)).toEqual({ exitCode: 137, signal: 'SIGKILL' });
    expect(resolveConfinedExit(1, null, 139)).toEqual({ exitCode: 139, signal: 'SIGSEGV' });
  });

  it("never reads the launcher's own words as a status", () => {
    // The finding this seam exists for: the launcher's stderr is the workload's
    // stderr, so a command whose closing bytes happen to read like the
    // launcher's signal line used to have its failure rewritten as success.
    // Nothing here parses text at all, so the status decides and it fails.
    expect(resolveConfinedExit(2, null, 2)).toEqual({ exitCode: 2, signal: null });
  });

  it('falls back to the launcher when no status was recorded, inventing nothing', () => {
    // A group killed on timeout never reaches the line that writes the file.
    expect(resolveConfinedExit(1, 'SIGKILL', undefined)).toEqual({
      exitCode: 1,
      signal: 'SIGKILL',
    });
    expect(resolveConfinedExit(1, null, undefined)).toEqual({ exitCode: 1, signal: null });
    expect(resolveConfinedExit(null, null, undefined)).toEqual({ exitCode: null, signal: null });
  });
});

describe('the status file the wrapper writes', () => {
  it('lives in the run scratch, not in the binding', () => {
    expect(workloadStatusPath('/scratch/run-1')).toBe('/scratch/run-1/workload-status');
  });

  it('reads back what a shell wrote, and nothing else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'host-status-'));
    const path = workloadStatusPath(dir);

    // Absent: the wrapper never got that far.
    expect(await readWorkloadStatus(path)).toBeUndefined();

    await writeFile(path, '141');
    expect(await readWorkloadStatus(path)).toBe(141);

    // Anything that is not a status a shell can report is no status at all,
    // rather than a number to act on — including a number with anything after it.
    for (const written of ['', 'nonsense', '-1', '256', '3; rm -rf /', '0 0']) {
      await writeFile(path, written);
      expect(await readWorkloadStatus(path)).toBeUndefined();
    }
    await rm(dir, { recursive: true, force: true });
  });
});

/**
 * Contract: the launcher's options never eat the command's.
 *
 * The launcher's own parser owns `-c <command>` — which is also how `sh`, `bash`
 * and `python` spell it — and took it from anywhere in the argv.
 */
describe('the argv handed to the launcher', () => {
  it("puts the launcher's flags first and everything else past `--`", () => {
    const argv = confinedArgv('/srt/cli.js', '/scratch/srt-settings.json', '/scratch/st', [
      '/usr/bin/python3',
      '-c',
      'print(1)',
    ]);
    expect(argv.slice(0, 4)).toEqual(['/srt/cli.js', '-s', '/scratch/srt-settings.json', '--']);
    // Everything the workload brought, in order, after the separator.
    expect(argv.slice(-3)).toEqual(['/usr/bin/python3', '-c', 'print(1)']);
    expect(argv.indexOf('--')).toBeLessThan(argv.indexOf('/usr/bin/python3'));
  });

  it('hands the command its argv unchanged', () => {
    const wrapped = statusWrappedArgv('/scratch/st', ['prog', 'a b', '$HOME', '-s', '']);
    expect(wrapped.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(wrapped.slice(-5)).toEqual(['prog', 'a b', '$HOME', '-s', '']);
    // The status path travels as an argument, not inside the script, so no path
    // is ever spliced into shell text.
    expect(wrapped[2]).not.toContain('/scratch/st');
    expect(wrapped[4]).toBe('/scratch/st');
  });
});

/**
 * Contract: what the wrapper records for a real process.
 *
 * Run without the launcher — the wrapper is the part under test, and every
 * machine has a shell where not every machine can confine anything. `sh` is
 * exactly what the launcher will run inside the boundary.
 */
describe('the wrapper, over a real process', () => {
  async function statusOf(
    argv: string[],
    options: { statusPath?: string } = {},
  ): Promise<{ closeCode: number | null; status: number | undefined; stdout: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'host-wrap-'));
    const statusPath = options.statusPath ?? workloadStatusPath(dir);
    const full = statusWrappedArgv(statusPath, argv);
    const child = spawn(full[0] as string, full.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    const closeCode = await new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
    });
    const status = await readWorkloadStatus(statusPath);
    await rm(dir, { recursive: true, force: true });
    return { closeCode, status, stdout };
  }

  it('records 0 for a command that worked, and passes its output through', async () => {
    const { status, stdout, closeCode } = await statusOf(['/bin/echo', 'hello']);
    expect(status).toBe(0);
    expect(closeCode).toBe(0);
    expect(stdout).toContain('hello');
  }, 30_000);

  it('records the code of a command that failed on its own', async () => {
    const { status } = await statusOf(['/bin/sh', '-c', 'exit 3']);
    expect(status).toBe(3);
    expect(resolveConfinedExit(3, null, 3)).toEqual({ exitCode: 3, signal: null });
  }, 30_000);

  it('records 141 for a writer killed by a reader that stopped reading', async () => {
    // The original observation, at the level the wrapper sees it: `head` reads
    // its three lines and exits, and whatever feeds it dies of SIGPIPE.
    const { status, stdout } = await statusOf([
      '/bin/bash',
      '-c',
      'cd "$(mktemp -d)"; mkfifo fifo; head -n 3 < fifo & exec seq 1 200000 > fifo',
    ]);
    expect(status).toBe(141);
    expect(resolveConfinedExit(141, null, status)).toEqual({ exitCode: 0, signal: 'SIGPIPE' });
    expect(stdout).toContain('1\n2\n3\n');
  }, 30_000);

  it('records 137 for a command killed outright', async () => {
    const { status } = await statusOf(['/bin/sh', '-c', 'kill -KILL $$']);
    expect(status).toBe(137);
    expect(resolveConfinedExit(1, null, status)).toEqual({ exitCode: 137, signal: 'SIGKILL' });
  }, 30_000);

  it("fails a command whose last words read like the launcher's signal line", async () => {
    // The MAJOR finding, from the other side: the workload can write anything it
    // likes on the stream it shares with the launcher and still fails.
    const { status } = await statusOf([
      '/bin/sh',
      '-c',
      'echo "Process killed by signal: SIGPIPE" 1>&2; exit 2',
    ]);
    expect(status).toBe(2);
    expect(resolveConfinedExit(2, null, status)).toEqual({ exitCode: 2, signal: null });
  }, 30_000);

  it('degrades to the launcher exit when the status cannot be written', async () => {
    // A scratch that is gone, a group killed before the wrapper's last line:
    // the status is missing rather than wrong, and a missing one is never read
    // as success.
    const { status, closeCode } = await statusOf(['/bin/sh', '-c', 'exit 3'], {
      statusPath: join(tmpdir(), 'host-wrap-no-such-dir', 'workload-status'),
    });
    expect(status).toBeUndefined();
    expect(resolveConfinedExit(closeCode, null, status)).toEqual({ exitCode: 3, signal: null });
  }, 30_000);
});

describe.runIf(CAN_CONFINE)('host process execution', () => {
  it('runs a command inside the binding', async () => {
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath, noPushApprovals);
    await handler.execute(
      contextFor('host.process.exec', { bindingId: 'hb', command: ['echo', 'hello'] }, captured),
    );
    expect(captured.output?.['exitCode']).toBe(0);
    expect(String(captured.output?.['stdout'])).toContain('hello');
    // The result says how it ran. Everything but a permitted push is confined,
    // and a reader of the step should not have to infer which it got.
    expect(captured.output?.['confined']).toBe(true);
  }, 60_000);

  it('reports a pipeline into `head` as having worked', async () => {
    // The writer is the process the launcher supervises, which is the shape that
    // reaches this executor: `head` reads its three lines, exits, and whatever
    // feeds it is killed for writing to a pipe nobody reads. The launcher reports
    // that as `exit 1` with no signal, so a pipeline that produced exactly what
    // was asked of it was indistinguishable from a command that failed.
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath, noPushApprovals);
    await handler.execute(
      contextFor(
        'host.process.exec',
        {
          bindingId: 'hb',
          command: [
            '/bin/bash',
            '-c',
            'rm -f fifo; mkfifo fifo; head -n 3 < fifo & exec seq 1 200000 > fifo',
          ],
        },
        captured,
      ),
    );
    expect(captured.output?.['exitCode']).toBe(0);
    expect(captured.output?.['signal']).toBe('SIGPIPE');
    expect(String(captured.output?.['stdout'] ?? '')).toContain('1\n2\n3\n');
    // The pipe was made inside the connected folder, which is a real one on this
    // machine; a test that leaves a device node behind in it is a test that
    // changed the operator's project.
    await rm(join(root, 'fifo'), { force: true });
  }, 60_000);

  it("fails a command whose closing words are the launcher's signal line", async () => {
    // The launcher spawns the command with `stdio: 'inherit'`, so this text
    // arrives on exactly the stream the launcher writes its own line to. The
    // status comes from the wrapper's file instead, so the command still fails.
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath, noPushApprovals);
    await handler.execute(
      contextFor(
        'host.process.exec',
        {
          bindingId: 'hb',
          command: ['/bin/bash', '-c', 'echo "Process killed by signal: SIGPIPE" 1>&2; exit 2'],
        },
        captured,
      ),
    );
    expect(captured.output?.['exitCode']).toBe(2);
    expect(captured.output?.['signal']).toBeNull();
  }, 60_000);

  it("runs a command whose own flags spell the launcher's", async () => {
    // `-c` is the launcher's option as well as the shell's, and it took it from
    // anywhere in the argv: the script was lifted out and run without `python`.
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath, noPushApprovals);
    await handler.execute(
      contextFor(
        'host.process.exec',
        { bindingId: 'hb', command: ['/bin/bash', '-c', 'printf %s "$0"', 'named-zero'] },
        captured,
      ),
    );
    expect(captured.output?.['exitCode']).toBe(0);
    expect(String(captured.output?.['stdout'] ?? '')).toContain('named-zero');
  }, 60_000);

  it('reports a shell-absorbed pipeline into `head` as success too', async () => {
    // The ordinary spelling, where the shell outlives the writer and reports
    // `head`'s own status. It was already right; asserted so it stays right.
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath, noPushApprovals);
    await handler.execute(
      contextFor(
        'host.process.exec',
        { bindingId: 'hb', command: ['/bin/bash', '-c', 'seq 1 200000 | head -n 3'] },
        captured,
      ),
    );
    expect(captured.output?.['exitCode']).toBe(0);
    expect(String(captured.output?.['stdout'] ?? '')).toContain('1\n2\n3\n');
  }, 60_000);

  it('still fails a command that failed for its own reason', async () => {
    // The other half of the fix: nothing about a broken pipe weakens this.
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath, noPushApprovals);
    await handler.execute(
      contextFor(
        'host.process.exec',
        { bindingId: 'hb', command: ['/bin/bash', '-c', 'exit 3'] },
        captured,
      ),
    );
    expect(captured.output?.['exitCode']).toBe(3);
  }, 60_000);

  it('denies the command what lives under the operator home', async () => {
    // The property that matters: keys, cloud credentials, browser profiles and
    // this executor's own pairing state all live under home, and the policy
    // denies that region wholesale.
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath, noPushApprovals);
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
    const handler = createHostProcessHandler(policyPath, noPushApprovals);
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
    const handler = createHostProcessHandler(policyPath, noPushApprovals);
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
    const handler = createHostProcessHandler(policyPath, noPushApprovals);
    const result = await handler.execute(
      contextFor('host.process.inspect', { bindingId: 'hb_files', processId: 'hp_x' }, captured),
    );
    expect(result.status).toBe('FAILED');
  }, 30_000);

  it('refuses an unknown binding rather than running anything', async () => {
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath, noPushApprovals);
    const result = await handler.execute(
      contextFor('host.process.exec', { bindingId: 'nope', command: ['echo', 'x'] }, captured),
    );
    expect(result.status).toBe('FAILED');
  }, 30_000);

  it('refuses an env that would run code before the sandbox is installed', async () => {
    // The spawned process is a plain Node process until the adapter's CLI
    // installs the boundary, and Node reads NODE_OPTIONS at boot.
    const captured: Captured = {};
    const handler = createHostProcessHandler(policyPath, noPushApprovals);
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
    const handler = createHostProcessHandler(policyPath, noPushApprovals);
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
    const handler = createHostProcessHandler(policyPath, noPushApprovals);
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
    const handler = createHostProcessHandler(policyPath, noPushApprovals);
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
    const handler = createHostProcessHandler(policyPath, noPushApprovals);
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
  let originMain: string;

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
    // `origin` is a real remote holding `main`, which every push measures what
    // it would add against.
    await execFileAsync('git', ['init', '-q', '--bare', join(repo, 'remote.git')]);
    await execFileAsync('git', ['-C', repo, 'remote', 'add', 'origin', join(repo, 'remote.git')]);
    await execFileAsync('git', ['-C', repo, 'push', '-q', 'origin', 'main']);
    originMain = (await execFileAsync('git', ['-C', repo, 'rev-parse', 'main'])).stdout.trim();

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
    const result = await createHostProcessHandler(pushPolicyPath, noPushApprovals).execute(
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
    // The remote holds nothing under the prefix, which is the property behind the assertion.
    const refs = await execFileAsync('git', ['-C', join(repo, 'remote.git'), 'branch', '--list']);
    expect(refs.stdout).not.toContain('aflow/');
  }, 30_000);

  it('refuses any push from a folder that declared no prefix', async () => {
    const captured: Captured = {};
    const result = await createHostProcessHandler(pushPolicyPath, noPushApprovals).execute(
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
    const result = await createHostProcessHandler(pushPolicyPath, noPushApprovals).execute(
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
    expect(refs.stdout).not.toContain('aflow/');
  }, 30_000);

  it('refuses a push carrying an environment of its own', async () => {
    // The environment a push runs in is the operator's, so a job cannot add to
    // it — `GIT_SSH_COMMAND` there would be a program of the job's choosing.
    const captured: Captured = {};
    const result = await createHostProcessHandler(pushPolicyPath, noPushApprovals).execute(
      contextFor(
        'host.process.exec',
        {
          bindingId: 'hb_push',
          command: ['git', 'push', ...PUSH_REQUIRED_OPTIONS, './remote.git', 'aflow/ready'],
          env: { GIT_SSH_COMMAND: '/tmp/anything' },
        },
        captured,
      ),
    );
    expect(result.status).toBe('FAILED');
    expect(captured.output?.['code']).toBe('PERMISSION_DENIED');
    const refs = await execFileAsync('git', ['-C', join(repo, 'remote.git'), 'branch', '--list']);
    expect(refs.stdout).not.toContain('aflow/');
  }, 30_000);

  /** What a scan by this executor of `origin/main..<sha>` in `hb_push` returns. */
  function receiptFor(sha: string, outcome: ScanOutcome = 'clean', now?: number): string {
    return issueScanReceipt({ bindingId: 'hb_push', base: originMain, sha, outcome }, now);
  }

  it('lets a branch under the prefix through to the remote, as the operator’s own git', async () => {
    // Unconfined, which is why this needs no sandbox to run: the push that
    // failed in production passed the rule and then met the sandbox's proxy,
    // which git over SSH cannot authenticate to.
    const sha = (
      await execFileAsync('git', ['-C', repo, 'rev-parse', 'aflow/ready'])
    ).stdout.trim();
    const captured: Captured = {};
    const result = await createHostProcessHandler(pushPolicyPath, noPushApprovals).execute(
      contextFor(
        'host.process.exec',
        {
          bindingId: 'hb_push',
          command: [
            'git',
            'push',
            ...PUSH_REQUIRED_OPTIONS,
            'origin',
            `${sha}:refs/heads/aflow/ready`,
          ],
          pushBase: 'main',
          scan: { receipt: receiptFor(sha) },
        },
        captured,
      ),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(captured.output?.['exitCode']).toBe(0);
    expect(captured.output?.['confined']).toBe(false);
    const refs = await execFileAsync('git', ['-C', join(repo, 'remote.git'), 'branch', '--list']);
    expect(refs.stdout).toContain('aflow/ready');
  }, 60_000);

  /** A commit on top of `parent` with the parent's tree, made without a checkout. */
  async function commitOn(parent: string, message: string): Promise<string> {
    const tree = (await execFileAsync('git', ['-C', repo, 'rev-parse', `${parent}^{tree}`])).stdout;
    const made = await execFileAsync('git', [
      '-C',
      repo,
      'commit-tree',
      tree.trim(),
      '-p',
      parent,
      '-m',
      message,
    ]);
    return made.stdout.trim();
  }

  async function pushCommit(sha: string, branch: string): Promise<Captured & { status: string }> {
    const captured: Captured = {};
    const result = await createHostProcessHandler(pushPolicyPath, noPushApprovals).execute(
      contextFor(
        'host.process.exec',
        {
          bindingId: 'hb_push',
          command: [
            'git',
            'push',
            ...PUSH_REQUIRED_OPTIONS,
            'origin',
            `${sha}:refs/heads/${branch}`,
          ],
          pushBase: 'main',
          scan: { receipt: receiptFor(sha) },
        },
        captured,
      ),
    );
    return { ...captured, status: result.status };
  }

  async function remoteHead(branch: string): Promise<string> {
    const head = await execFileAsync('git', [
      '-C',
      join(repo, 'remote.git'),
      'rev-parse',
      `refs/heads/${branch}`,
    ]);
    return head.stdout.trim();
  }

  it('pushes exactly the commit it names, whatever the local branch holds since', async () => {
    const initial = (await execFileAsync('git', ['-C', repo, 'rev-parse', 'main'])).stdout.trim();
    const reviewed = await commitOn(initial, 'the reviewed change');
    const pushed = await pushCommit(reviewed, 'aflow/by-sha');
    expect(pushed.status).toBe('SUCCEEDED');
    expect(pushed.output?.['exitCode']).toBe(0);
    expect(await remoteHead('aflow/by-sha')).toBe(reviewed);
  }, 60_000);

  it("fails a push the remote refuses, with git's own message, and moves nothing", async () => {
    const initial = (await execFileAsync('git', ['-C', repo, 'rev-parse', 'main'])).stdout.trim();
    const landed = await commitOn(initial, 'what the remote holds');
    expect((await pushCommit(landed, 'aflow/moved')).status).toBe('SUCCEEDED');

    const sibling = await commitOn(initial, 'made from the old head');
    const refused = await pushCommit(sibling, 'aflow/moved');

    expect(refused.status).toBe('FAILED');
    expect(refused.output?.['code']).toBe('PROVIDER_ERROR');
    expect(refused.output?.['retryable']).toBe(false);
    const message = String(refused.output?.['message']);
    expect(message).toContain('The push did not land');
    expect(message).toContain('[rejected]');
    expect(await remoteHead('aflow/moved')).toBe(landed);
  }, 60_000);

  it('sends no tag the operator’s `push.followTags` would add', async () => {
    const initial = (await execFileAsync('git', ['-C', repo, 'rev-parse', 'main'])).stdout.trim();
    const tagged = await commitOn(initial, 'a commit with a tag on it');
    await execFileAsync('git', ['-C', repo, 'tag', '-a', '-m', 'unscanned', 'v-follow', tagged]);
    await execFileAsync('git', ['-C', repo, 'config', 'push.followTags', 'true']);
    try {
      const unpinned = await createHostProcessHandler(pushPolicyPath, noPushApprovals).execute(
        contextFor(
          'host.process.exec',
          {
            bindingId: 'hb_push',
            command: ['git', 'push', './remote.git', `${tagged}:refs/heads/aflow/tagged`],
          },
          {},
        ),
      );
      expect(unpinned.status).toBe('FAILED');

      const pushed = await pushCommit(tagged, 'aflow/tagged');
      expect(pushed.status).toBe('SUCCEEDED');
      expect(await remoteHead('aflow/tagged')).toBe(tagged);
      const tags = await execFileAsync('git', ['-C', join(repo, 'remote.git'), 'tag', '--list']);
      expect(tags.stdout.trim()).toBe('');
    } finally {
      await execFileAsync('git', ['-C', repo, 'config', '--unset', 'push.followTags']);
    }
  }, 60_000);
});

/**
 * The receipt and the approval a push carries, through the handler: every
 * refusal is named, comes before anything is spawned, and leaves the remote as
 * it was.
 */
describe('a push sends only a range this executor scanned', () => {
  let pushBase: string;
  let repo: string;
  let pushPolicyPath: string;
  /** Where `origin/main` is, which every push measures from. */
  let base: string;
  /** Two commits on top of `base` that `origin` does not have; `tip` is the one pushed. */
  let middle: string;
  let tip: string;

  async function commitOn(parent: string, message: string): Promise<string> {
    const tree = (await execFileAsync('git', ['-C', repo, 'rev-parse', `${parent}^{tree}`])).stdout;
    const made = await execFileAsync('git', [
      '-C',
      repo,
      'commit-tree',
      tree.trim(),
      '-p',
      parent,
      '-m',
      message,
    ]);
    return made.stdout.trim();
  }

  beforeAll(async () => {
    pushBase = await mkdtemp(join(tmpdir(), 'host-receipt-'));
    repo = join(pushBase, 'repo');
    await mkdir(repo, { recursive: true });
    await execFileAsync('git', ['init', '-q', '--initial-branch=main', repo]);
    await execFileAsync('git', ['-C', repo, 'config', 'user.email', 't@e.com']);
    await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'T']);
    await writeFile(join(repo, 'a.txt'), 'one\n');
    await execFileAsync('git', ['-C', repo, 'add', '-A']);
    await execFileAsync('git', ['-C', repo, 'commit', '-q', '-m', 'initial']);
    base = (await execFileAsync('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    await execFileAsync('git', ['init', '-q', '--bare', join(pushBase, 'remote.git')]);
    await execFileAsync('git', [
      '-C',
      repo,
      'remote',
      'add',
      'origin',
      join(pushBase, 'remote.git'),
    ]);
    await execFileAsync('git', ['-C', repo, 'push', '-q', 'origin', 'main']);
    middle = await commitOn(base, 'unpushed, under the commit');
    tip = await commitOn(middle, 'the commit');
    pushPolicyPath = join(pushBase, 'host-policy.json');
    const binding = (id: string, pushApproval?: HostPushApproval) => ({
      id,
      root: repo,
      mode: 'readwrite',
      allowsExecution: true,
      branchPolicy: { branchPrefix: 'aflow/', ...(pushApproval ? { pushApproval } : {}) },
      singleFile: false,
      spaceId: 'space-test',
    });
    await writeFile(
      pushPolicyPath,
      JSON.stringify({
        version: 1,
        bindings: [
          binding('hb_push'),
          binding('hb_other'),
          binding('hb_always', 'always'),
          binding('hb_never', 'never'),
        ],
      }),
    );
  });

  /** A receipt for `<from>..<sha>`, by default the whole of what a push of `tip` adds. */
  function receipt(
    outcome: ScanOutcome = 'clean',
    fields: { from?: string; sha?: string; bindingId?: string; now?: number } = {},
  ): string {
    return issueScanReceipt(
      {
        bindingId: fields.bindingId ?? 'hb_push',
        base: fields.from ?? base,
        sha: fields.sha ?? tip,
        outcome,
      },
      fields.now,
    );
  }

  async function push(
    input: {
      receipt?: string;
      refspecs?: readonly string[];
      program?: string;
      /** `null` sends none. */
      pushBase?: string | null;
      approvals?: PushApprovalReader;
      bindingId?: string;
    } = {},
  ): Promise<{ status: string; captured: Captured }> {
    const captured: Captured = {};
    const handler = createHostProcessHandler(pushPolicyPath, input.approvals ?? noPushApprovals);
    const result = await handler.execute(
      contextFor(
        'host.process.exec',
        {
          bindingId: input.bindingId ?? 'hb_push',
          command: [
            input.program ?? 'git',
            'push',
            ...PUSH_REQUIRED_OPTIONS,
            'origin',
            ...(input.refspecs ?? [`${tip}:refs/heads/aflow/x`]),
          ],
          ...(input.pushBase === null ? {} : { pushBase: input.pushBase ?? 'main' }),
          ...(input.receipt !== undefined ? { scan: { receipt: input.receipt } } : {}),
        },
        captured,
      ),
    );
    return { status: result.status, captured };
  }

  async function remoteBranches(): Promise<string> {
    const listed = await execFileAsync('git', [
      '-C',
      join(pushBase, 'remote.git'),
      'branch',
      '--list',
      'aflow/*',
    ]);
    return listed.stdout.trim();
  }

  function expectRefused(
    outcome: { status: string; captured: Captured },
    name: string,
    said: string,
  ): void {
    expect(outcome.status, name).toBe('FAILED');
    expect(outcome.captured.output?.['code'], name).toBe('PERMISSION_DENIED');
    expect(String(outcome.captured.output?.['message']), name).toContain(said);
    expect(outcome.captured.output?.['exitCode'], name).toBeUndefined();
  }

  it('refuses every push it cannot tie to a scan, naming why, with nothing pushed', async () => {
    const valid = receipt();
    const forged = `${valid.slice(0, valid.indexOf('.'))}.${'A'.repeat(43)}`;
    const other = 'f'.repeat(40);
    const cases: ReadonlyArray<readonly [string, Parameters<typeof push>[0], string]> = [
      ['no push base', { receipt: valid, pushBase: null }, 'This push names no `pushBase`'],
      ['no receipt', {}, 'carries no scan receipt'],
      ['forged', { receipt: forged }, 'did not issue since it last started'],
      [
        'another folder',
        { receipt: receipt('clean', { bindingId: 'hb_other' }) },
        'a scan of `hb_other`, and pushes from `hb_push`',
      ],
      [
        'stale',
        { receipt: receipt('clean', { now: Date.now() - RECEIPT_TTL_MS - 1 }) },
        'more than a day ago',
      ],
      [
        'another commit',
        { receipt: receipt('clean', { sha: other }) },
        `its receipt is for a scan of \`${base}..${other}\``,
      ],
      [
        'a branch name for the source',
        { receipt: valid, refspecs: ['main:refs/heads/aflow/x'] },
        `This push sends \`main\`, and its receipt is for a scan of \`${base}..${tip}\``,
      ],
      [
        'a second refspec',
        { receipt: valid, refspecs: [`${tip}:refs/heads/aflow/x`, `${tip}:refs/heads/aflow/y`] },
        'the one commit its scan ended at',
      ],
    ];
    for (const [name, input, said] of cases) {
      expectRefused(await push(input), name, said);
    }
    expect(await remoteBranches()).toBe('');
  }, 60_000);

  it('refuses a receipt for any range but the one from where origin is, naming both', async () => {
    for (const [name, from] of [
      ['<tip>..<tip>', tip],
      ['<tip^>..<tip>', middle],
    ] as const) {
      expectRefused(
        await push({ receipt: receipt('clean', { from }) }),
        name,
        `\`origin/main\` is at \`${base}\`, so this push sends \`${base}..${tip}\`, and its ` +
          `receipt is for a scan of \`${from}..${tip}\``,
      );
    }
    expect(await remoteBranches()).toBe('');

    const whole = await push({ receipt: receipt('clean') });
    expect(whole.status).toBe('SUCCEEDED');
    expect(await remoteBranches()).toContain('aflow/x');
  }, 60_000);

  describe('a range its scan asked about', () => {
    function grant(requestHash: string): WriteApprovalGrant {
      return { requestHash, decision: 'approved', approvedBy: 'operator-1' };
    }

    for (const outcome of ['unscanned', 'allowed'] as const) {
      it(`${outcome}: pushes only on the operator's grant for exactly this push in this run`, async () => {
        const asked = receipt(outcome);
        const refspec = `${tip}:refs/heads/aflow/${outcome}`;
        const hash = hostPushRequestHash({ bindingId: 'hb_push', refspec, receipt: asked });
        const otherHash = hostPushRequestHash({
          bindingId: 'hb_push',
          refspec: `${tip}:refs/heads/aflow/elsewhere`,
          receipt: asked,
        });
        const why =
          outcome === 'unscanned'
            ? 'could not read all of it'
            : 'found lines in it marked `aflow-scan: allow`';
        const refusals: ReadonlyArray<readonly [string, Map<string, WriteApprovalGrant>]> = [
          ['no grant', new Map()],
          [
            'a grant for another push',
            new Map([[`${TENANT}:${RUN}:${otherHash}`, grant(otherHash)]]),
          ],
          ['a grant in another run', new Map([[`${TENANT}:run-other:${hash}`, grant(hash)]])],
          [
            'a declined push',
            new Map([
              [`${TENANT}:${RUN}:${hash}`, { ...grant(hash), decision: 'denied' as const }],
            ]),
          ],
        ];
        for (const [name, grants] of refusals) {
          expectRefused(
            await push({
              receipt: asked,
              refspecs: [refspec],
              approvals: pushApprovalsHolding(grants),
            }),
            name,
            `${why}, so it is pushed only once the operator has approved this push`,
          );
        }
        expect(await remoteBranches()).not.toContain(`aflow/${outcome}`);

        const approved = await push({
          receipt: asked,
          refspecs: [refspec],
          approvals: pushApprovalsHolding(new Map([[`${TENANT}:${RUN}:${hash}`, grant(hash)]])),
        });
        expect(approved.status).toBe('SUCCEEDED');
        expect(await remoteBranches()).toContain(`aflow/${outcome}`);
      }, 60_000);
    }
  });

  describe("the folder's push approval", () => {
    function pushOf(bindingId: string, outcome: ScanOutcome, branch: string) {
      const scanned = receipt(outcome, { bindingId });
      const refspec = `${tip}:refs/heads/aflow/${branch}`;
      const hash = hostPushRequestHash({ bindingId, refspec, receipt: scanned });
      return {
        input: { bindingId, receipt: scanned, refspecs: [refspec] },
        granted: pushApprovalsHolding(
          new Map([
            [
              `${TENANT}:${RUN}:${hash}`,
              { requestHash: hash, decision: 'approved' as const, approvedBy: 'operator-1' },
            ],
          ]),
        ),
      };
    }

    it('always: a clean range is pushed only on the operator’s grant, the refusal naming the posture', async () => {
      const clean = pushOf('hb_always', 'clean', 'always-clean');
      expectRefused(
        await push(clean.input),
        'clean, no grant',
        'The push approval of `hb_always` is `always`, so it is pushed only once the operator ' +
          'has approved this push',
      );
      const allowed = pushOf('hb_always', 'allowed', 'always-allowed');
      expectRefused(
        await push(allowed.input),
        'allowed, no grant',
        'The push approval of `hb_always` is `always`, and the scan of ' +
          `\`${base}..${tip}\` found lines in it marked \`aflow-scan: allow\`, so it is pushed`,
      );
      expect(await remoteBranches()).not.toContain('aflow/always-');

      const approved = await push({ ...clean.input, approvals: clean.granted });
      expect(approved.status).toBe('SUCCEEDED');
      expect(await remoteBranches()).toContain('aflow/always-clean');
    }, 60_000);

    it('never: a clean range is pushed with no grant', async () => {
      const clean = pushOf('hb_never', 'clean', 'never-clean');
      expect((await push(clean.input)).status).toBe('SUCCEEDED');
      expect(await remoteBranches()).toContain('aflow/never-clean');
    }, 60_000);
  });

  it('refuses a receipt or a push base on anything but a push', async () => {
    for (const [field, extra] of [
      ['scan', { scan: { receipt: receipt() } }],
      ['pushBase', { pushBase: 'main' }],
    ] as const) {
      const captured: Captured = {};
      const result = await createHostProcessHandler(pushPolicyPath, noPushApprovals).execute(
        contextFor(
          'host.process.exec',
          { bindingId: 'hb_push', command: ['git', 'status'], ...extra },
          captured,
        ),
      );
      expect(result.status, field).toBe('FAILED');
      expect(String(captured.output?.['message']), field).toContain(
        `\`${field}\` is checked before a push`,
      );
    }
  });

  it("runs the push under the operator's transport and credentials, and no other git config", async () => {
    // A git that prints the environment it was handed, at a path the push rule
    // reads as git's; the base is measured with the real one before it runs.
    const bin = join(pushBase, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'git'), '#!/bin/sh\nenv\n', { mode: 0o755 });
    const operatorConfig = join(pushBase, 'operator.gitconfig');
    await writeFile(operatorConfig, '');
    const refused: Record<string, string> = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'remote.origin.pushurl',
      GIT_CONFIG_VALUE_0: '/elsewhere.git',
      GIT_CONFIG_PARAMETERS: "'remote.origin.pushurl'='/elsewhere.git'",
      GIT_CONFIG_SYSTEM: join(pushBase, 'system-config'),
      AFLOW_UNRELATED: 'kept out',
    };
    const carried: Record<string, string> = {
      // The operator's own global config, read by their git as by the measure.
      GIT_CONFIG_GLOBAL: operatorConfig,
      SSH_AUTH_SOCK: join(pushBase, 'agent.sock'),
      GH_TOKEN: 'operator-gh-credential',
      GITHUB_TOKEN: 'operator-github-credential',
      GIT_ASKPASS: join(pushBase, 'askpass'),
      SSH_ASKPASS: join(pushBase, 'ssh-askpass'),
      DISPLAY: ':0',
    };
    const planted = { ...refused, ...carried };
    const saved = new Map(Object.keys(planted).map((name) => [name, process.env[name]]));
    Object.assign(process.env, planted);
    try {
      const { status, captured } = await push({ receipt: receipt(), program: join(bin, 'git') });
      expect(status).toBe('SUCCEEDED');
      const handed = new Map(
        String(captured.output?.['stdout'])
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      );
      for (const name of Object.keys(refused)) expect(handed.has(name), name).toBe(false);
      for (const [name, value] of Object.entries(carried)) {
        expect(handed.get(name), name).toBe(value);
      }
      expect([...handed.keys()].filter((name) => name.startsWith('GIT_CONFIG_'))).toEqual([
        'GIT_CONFIG_GLOBAL',
      ]);
      expect(handed.get('GIT_NO_REPLACE_OBJECTS')).toBe('1');
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 60_000);
});
