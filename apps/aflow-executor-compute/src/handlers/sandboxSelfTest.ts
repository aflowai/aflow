/**
 * Boot-time self-test for the sandbox bind-mount path namespace.
 *
 * The compute substrate depends on one invariant (see sandboxHostDir.ts): a host
 * directory we write to in the executor and then bind-mount into a container
 * (`-v hostDir:/...`) must resolve to the SAME bytes for the Docker daemon. When
 * the executor runs inside the `phoenix-worker` container and talks to the HOST
 * daemon over the socket, that only holds if the scratch root is mounted into the
 * worker at an identical host path. If it is NOT, Docker silently bind-mounts a
 * freshly-created empty dir and every workspace/input mount is invisible inside
 * the sandbox — the "hydrated but empty" bug, which otherwise only surfaces deep
 * inside an agent run with a confusing FileNotFoundError.
 *
 * This probe makes that failure loud at boot: write a marker file under the
 * sandbox base dir, bind-mount it read-only into a throwaway container, and read
 * the marker back through the mount. If the bytes match, the namespace is wired
 * correctly. If not (or docker errors), we log a loud remediation message and —
 * in strict mode — refuse to start.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile, chmod } from 'node:fs/promises';

import type { ExecutorLogger } from '@aflow/executor-runtime';

import { getImageForRuntime } from './containerRunner.js';
import { sandboxHostBaseDir, sandboxScratchDir, SANDBOX_HOST_DIR_ENV } from './sandboxHostDir.js';

export interface SandboxSelfTestResult {
  ok: boolean;
  /** The resolved sandbox base dir that was probed. */
  baseDir: string;
  /** Human-readable detail (mismatch reason or docker error), set when !ok. */
  detail?: string;
}

/** Run `docker <args>` and resolve its stdout, rejecting on non-zero exit. */
function dockerExec(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Probe the sandbox bind-mount path namespace. Never throws — any failure is
 * captured into the returned result so the caller decides whether to hard-fail.
 */
export async function verifySandboxBindMount(opts: {
  log: ExecutorLogger;
  /** Image to run the probe in. Defaults to the bash runtime image (tiny, pre-pulled). */
  image?: string;
  timeoutMs?: number;
}): Promise<SandboxSelfTestResult> {
  const baseDir = sandboxHostBaseDir();
  const image = opts.image ?? getImageForRuntime('bash');
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const probeDir = sandboxScratchDir(`phoenix-selftest-${randomUUID().slice(0, 12)}`);
  const token = randomUUID();

  try {
    await mkdir(probeDir, { recursive: true });
    // 0o777: the probe container runs as 1000:1000 and must read through the mount.
    await chmod(probeDir, 0o777);
    await writeFile(`${probeDir}/marker`, token, 'utf-8');

    const stdout = await dockerExec(
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--user',
        '1000:1000',
        '--security-opt',
        'no-new-privileges:true',
        '--cap-drop',
        'ALL',
        '-v',
        `${probeDir}:/probe:ro`,
        image,
        'cat',
        '/probe/marker',
      ],
      timeoutMs,
    );

    if (stdout.trim() === token) {
      return { ok: true, baseDir };
    }
    return {
      ok: false,
      baseDir,
      detail:
        `marker mismatch: wrote "${token}" to ${probeDir}/marker but the container ` +
        `read "${stdout.trim().slice(0, 64)}" through the bind-mount. The sandbox base ` +
        `dir is not visible to the Docker daemon at the same path.`,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      baseDir,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await rm(probeDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Run the self-test and apply the boot policy. Returns true if the executor may
 * proceed, false if it must refuse to start.
 *
 * Policy:
 *  - `PHOENIX_SANDBOX_SELFTEST=false` skips the probe entirely (returns true).
 *  - On pass: info log, proceed.
 *  - On fail: loud error log with remediation. Hard-fail (return false) only in
 *    STRICT mode; otherwise proceed with a warning (local dev may legitimately
 *    lack Docker or pre-pulled images).
 *  - STRICT defaults to ON when `PHOENIX_SANDBOX_HOST_DIR` is set (the prod-worker
 *    signal — we explicitly configured the shared mount and want it validated),
 *    and OFF otherwise. Override with `PHOENIX_SANDBOX_SELFTEST_STRICT=true|false`.
 */
export async function runSandboxSelfTest(log: ExecutorLogger): Promise<boolean> {
  if (process.env['PHOENIX_SANDBOX_SELFTEST'] === 'false') {
    log.warn('Sandbox bind-mount self-test skipped (PHOENIX_SANDBOX_SELFTEST=false)');
    return true;
  }

  const strictOverride = process.env['PHOENIX_SANDBOX_SELFTEST_STRICT'];
  const strict =
    strictOverride === 'true'
      ? true
      : strictOverride === 'false'
        ? false
        : (process.env[SANDBOX_HOST_DIR_ENV]?.trim().length ?? 0) > 0;

  const result = await verifySandboxBindMount({ log });
  if (result.ok) {
    log.info('Sandbox bind-mount self-test passed', { baseDir: result.baseDir });
    return true;
  }

  log.error(
    'Sandbox bind-mount self-test FAILED — sandbox file I/O (workspace, inputPaths, ' +
      '/tmp/output) will silently see empty mounts. The sandbox scratch dir is not ' +
      'visible to the Docker daemon at the same path. If this executor runs inside a ' +
      'container talking to the host Docker daemon, mount the scratch root into this ' +
      'container at an IDENTICAL host path and point ' +
      `${SANDBOX_HOST_DIR_ENV} at it (e.g. -v /var/lib/phoenix-sandbox:/var/lib/phoenix-sandbox ` +
      `and ${SANDBOX_HOST_DIR_ENV}=/var/lib/phoenix-sandbox).`,
    { baseDir: result.baseDir, detail: result.detail, strict },
  );

  if (strict) {
    return false;
  }
  log.warn('Continuing despite sandbox self-test failure (non-strict mode)');
  return true;
}
