import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile, readdir, mkdir, rm, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpaceComputePolicy } from '@aflow/schemas';

import { sandboxScratchDir } from './sandboxHostDir.js';
import { ensureImageAvailable } from '../ensureImage.js';

// ============================================================================
// Types
// ============================================================================

export interface ContainerRunRequest {
  /** Container image to use */
  image: string;
  /** Command to execute inside the container */
  command: string[];
  /** Environment variables */
  env?: Record<string, string> | undefined;
  /** Files to mount into the container (path relative to /tmp → content) */
  files?: Record<string, string> | undefined;
  /** Docker network mode ('none' for no network) */
  networkMode: string;
  /** Memory limit (Docker format, e.g. '512m') */
  memory: string;
  /** CPU limit (Docker format, e.g. '1') */
  cpus: string;
  /** Timeout in seconds */
  timeoutSeconds: number;
  /** Appended to the timeout-kill stderr so the agent learns the limit's origin and the raise knob. */
  timeoutTeaching?: string | undefined;
  workspace?: { hostDir: string } | undefined;
  /**
   * External abort (the step's withTimeout deadline, an orchestrator interrupt,
   * or a watchdog reap). When it fires, the container is killed so it stops
   * running detached and the executor's concurrency slot is released promptly
   * instead of staying pinned until the container's own timeout elapses.
   */
  signal?: AbortSignal | undefined;
}

export interface ContainerRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** Files written to /tmp/output/ during execution (path → content). */
  outputFiles?: Record<string, string> | undefined;
}

/**
 * Pluggable container runner interface.
 * Phase 1: DockerRunner (direct Docker CLI).
 * Future: CloudRunJobsRunner, KubernetesRunner.
 */
export interface ContainerRunner {
  run(request: ContainerRunRequest): Promise<ContainerRunResult>;
}

// ============================================================================
// Pre-built images
// ============================================================================

/**
 * Default images: use stock Docker Hub images that work out of the box.
 * Override with COMPUTE_IMAGE_PREFIX for custom Artifact Registry images in prod.
 */
const RUNTIME_IMAGES: Record<string, string> = {
  python3: 'python:3.12-slim',
  'python3-ml': 'phoenix-python-ml:latest',
  nodejs: 'node:22-slim',
  bash: 'alpine:3.20',
  deno: 'denoland/deno:alpine',
};

/**
 * Map variant runtimes to their base runtime for command building.
 * e.g., python3-ml uses the same python3 interpreter and wrapper logic.
 */
function baseRuntime(runtime: string): string {
  if (runtime === 'python3-ml') return 'python3';
  return runtime;
}

/**
 * Max inline output size for agent context (64KB).
 * Stdout/stderr beyond this is stored in PayloadRef + preview shown to agent.
 * Full capture limit is much higher (maxOutputBytes from schema, default 1MB).
 */
export const MAX_INLINE_OUTPUT_BYTES = 65_536;

/** Max total stdout/stderr capture (10MB). Prevents runaway output from OOM-ing the executor. */
export const MAX_CAPTURE_BYTES = 10_000_000;

/** `ChildProcess` is an `EventEmitter` at runtime; some @types/node merges omit `.on` on the class. */
function childAsEmitter(cp: ChildProcess): EventEmitter {
  return cp as EventEmitter;
}

/**
 * Get the Docker image for a given runtime.
 *
 * Custom images (prefixed `phoenix-`) are resolved via COMPUTE_IMAGE_PREFIX
 * to pull from Artifact Registry in production. Stock Docker Hub images
 * (python:3.12-slim, node:22-slim, etc.) are used as-is everywhere.
 */
export function getImageForRuntime(runtime: string): string {
  const prefix = process.env['COMPUTE_IMAGE_PREFIX'] ?? '';
  const image = RUNTIME_IMAGES[runtime];
  if (!image) {
    throw new Error(`Unsupported runtime: ${runtime}`);
  }
  // Only prefix custom phoenix images, not stock Docker Hub images
  if (prefix && image.startsWith('phoenix-')) {
    return `${prefix}/${image}`;
  }
  return image;
}

/**
 * Build the command to execute inside the container for a given language.
 *
 * When entryPoint is set, the code is written as a module and the entry function
 * is invoked with the provided args. This enables structured input/output patterns
 * where the agent passes data as args and reads the return value.
 *
 * When entryPoint is NOT set, args are passed as a JSON array via the
 * PHOENIX_ARGS env var (accessible from code).
 */
export function buildCommand(
  runtime: string,
  code: string,
  entryPoint?: string,
  args?: unknown[],
): string[] {
  if (entryPoint) {
    return buildEntryPointCommand(runtime, code, entryPoint, args);
  }

  // No entryPoint — execute code directly
  switch (baseRuntime(runtime)) {
    case 'python3':
      return ['python3', '-c', code];
    case 'nodejs':
      return ['node', '-e', code];
    case 'bash':
      return ['sh', '-c', code];
    case 'deno':
      return ['deno', 'eval', code];
    default:
      throw new Error(`Unsupported runtime: ${runtime}`);
  }
}

/**
 * Build a command that loads code as a module and calls entryPoint(args).
 * The result is JSON-serialized to stdout so the handler can extract it.
 */
function buildEntryPointCommand(
  runtime: string,
  code: string,
  entryPoint: string,
  args?: unknown[],
): string[] {
  // Sanitize entryPoint — must be a valid identifier
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entryPoint)) {
    throw new Error(`Invalid entryPoint: must be a valid identifier, got "${entryPoint}"`);
  }

  const argsJson = JSON.stringify(args ?? []);

  switch (baseRuntime(runtime)) {
    case 'python3': {
      // Write code to a temp module, import it, call entryPoint(*args), print result as JSON
      const wrapper =
        `import json, sys\n` +
        `exec(compile(${JSON.stringify(code)}, '<code>', 'exec'))\n` +
        `_result = ${entryPoint}(*json.loads(${JSON.stringify(argsJson)}))\n` +
        `if _result is not None:\n` +
        `    print(json.dumps(_result))`;
      return ['python3', '-c', wrapper];
    }
    case 'nodejs': {
      // Eval the code in a function scope, then call the exported entryPoint
      const wrapper =
        `const _mod = {};\n` +
        `(function(module, exports) { ${code} })(_mod, _mod.exports = {});\n` +
        `const _fn = _mod.exports[${JSON.stringify(entryPoint)}];\n` +
        `if (!_fn) { console.error("entryPoint '${entryPoint}' not found in exports"); process.exit(1); }\n` +
        `const _r = _fn(...${argsJson});\n` +
        `Promise.resolve(_r).then(v => { if (v !== undefined) console.log(JSON.stringify(v)); });`;
      return ['node', '-e', wrapper];
    }
    case 'deno': {
      const wrapper =
        `const _mod: Record<string, unknown> = {};\n` +
        `(function(exports: Record<string, unknown>) { ${code} })(_mod);\n` +
        `const _fn = _mod[${JSON.stringify(entryPoint)}];\n` +
        `if (typeof _fn !== 'function') { console.error("entryPoint '${entryPoint}' not found"); Deno.exit(1); }\n` +
        `const _r = await (_fn as Function)(...${argsJson});\n` +
        `if (_r !== undefined) console.log(JSON.stringify(_r));`;
      return ['deno', 'eval', wrapper];
    }
    case 'bash':
      // Bash doesn't have functions in the same way — entryPoint is treated as a function name in the script
      return [
        'sh',
        '-c',
        `${code}\n${entryPoint} ${args?.map((a) => JSON.stringify(String(a))).join(' ') ?? ''}`,
      ];
    default:
      throw new Error(`Unsupported runtime: ${runtime}`);
  }
}

/**
 * Resolve effective resource limits by merging input limits with space policy.
 * Space policy is the ceiling — input cannot exceed it.
 * If no policy is set, conservative defaults are used.
 */
export function resolveEffectiveLimits(
  inputLimits:
    | {
        timeoutSeconds?: number | undefined;
        memoryMB?: number | undefined;
        cpuCores?: number | undefined;
        maxOutputBytes?: number | undefined;
      }
    | undefined,
  policy: SpaceComputePolicy | undefined,
): {
  timeoutSeconds: number;
  memoryMb: number;
  cpuCores: number;
  maxOutputBytes: number;
  policyMaxTimeoutSeconds: number;
} {
  const policyResources = policy?.resources;
  const maxTimeout = policyResources?.maxExecutionSeconds ?? 900;
  const maxMemory = policyResources?.maxMemoryMb ?? 4096;
  const maxCpus = policyResources?.maxCpus ?? 4;

  return {
    policyMaxTimeoutSeconds: maxTimeout,
    timeoutSeconds: Math.min(inputLimits?.timeoutSeconds ?? 180, maxTimeout),
    memoryMb: Math.min(inputLimits?.memoryMB ?? 512, maxMemory),
    cpuCores: Math.min(inputLimits?.cpuCores ?? 1, maxCpus),
    maxOutputBytes: Math.min(inputLimits?.maxOutputBytes ?? 1_000_000, 10_000_000),
  };
}

/**
 * Docker `--pids-limit` for every sandbox container, ephemeral and session alike.
 * A fork bomb exhausts the host's PID table long before it trips the memory or CPU
 * cap, so this is the only flag that bounds one. The cgroup counts threads as well
 * as processes and a BLAS or multiprocessing workload spends them legitimately, so
 * the ceiling sits well above a plausible working set rather than at it.
 */
export const DEFAULT_SANDBOX_PIDS_LIMIT = '512';

const PIDS_LIMIT_ENV = 'COMPUTE_SANDBOX_PIDS_LIMIT';

/**
 * Containment flag shared by the ephemeral `docker run` and the session `docker
 * create`. An absent or malformed override keeps the default: Docker refuses the
 * whole command on one bad flag, so honouring a typo would turn it into a sandbox
 * where no container ever starts.
 */
export function sandboxPidsLimitArgs(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env[PIDS_LIMIT_ENV]?.trim();
  const valid = raw !== undefined && /^\d+$/.test(raw) && Number.parseInt(raw, 10) > 0;
  return ['--pids-limit', valid ? raw : DEFAULT_SANDBOX_PIDS_LIMIT];
}

// ============================================================================
// Docker Runner (Phase 1)
// ============================================================================

/**
 * Runs code in a Docker container via the Docker CLI.
 *
 * Security:
 * - `--network=none` by default (no network access)
 * - `--read-only` root filesystem
 * - `/tmp` writable for scratch files
 * - `--user 1000:1000` (non-root)
 * - `--rm` auto-cleanup
 * - `--no-healthcheck` disable healthchecks
 * - Resource limits enforced by Docker (--memory, --cpus, --pids-limit)
 * - Timeout enforced at two levels: Docker --stop-timeout + executor-side kill
 *
 * File mounting:
 * - Input files are written to a host-side temp dir and bind-mounted read-only at /tmp/input.
 * - The temp dir is cleaned up after execution regardless of outcome.
 */
export class DockerRunner implements ContainerRunner {
  async run(request: ContainerRunRequest): Promise<ContainerRunResult> {
    const containerName = `phoenix-compute-${randomUUID().slice(0, 12)}`;
    const startTime = Date.now();

    // Prepare host-side temp dir for input files if needed. Bind-mounted at
    // /tmp/input — must live under the shared sandbox base dir (DinD invariant,
    // see sandboxHostDir.ts).
    let hostFilesDir: string | undefined;
    if (request.files && Object.keys(request.files).length > 0) {
      hostFilesDir = sandboxScratchDir(`phoenix-files-${randomUUID().slice(0, 12)}`);
      await this.writeInputFiles(hostFilesDir, request.files);
    }

    // Prepare host-side output dir — always created so agent can write to /tmp/output/.
    // Bind-mounted, so it also lives under the shared sandbox base dir.
    const hostOutputDir = sandboxScratchDir(`phoenix-output-${randomUUID().slice(0, 12)}`);
    await mkdir(hostOutputDir, { recursive: true });
    // 0o777: container user (1000:1000) needs write access. Safe because the dir
    // is ephemeral — created per-run and cleaned up in the finally block below.
    await chmod(hostOutputDir, 0o777);

    try {
      const result = await this.runContainer(
        request,
        containerName,
        startTime,
        hostFilesDir,
        hostOutputDir,
      );

      // Read output files from /tmp/output/
      const outputFiles = await this.readOutputFiles(hostOutputDir);
      if (outputFiles && Object.keys(outputFiles).length > 0) {
        result.outputFiles = outputFiles;
      }

      return result;
    } finally {
      // Always clean up host-side temp dirs
      if (hostFilesDir) {
        await rm(hostFilesDir, { recursive: true, force: true }).catch(() => {
          /* best-effort cleanup */
        });
      }
      await rm(hostOutputDir, { recursive: true, force: true }).catch(() => {
        /* best-effort cleanup */
      });
    }
  }

  /**
   * Write input files to a host-side temp directory for bind-mounting.
   * File paths are sanitized to prevent path traversal.
   */
  private async writeInputFiles(hostDir: string, files: Record<string, string>): Promise<void> {
    await mkdir(hostDir, { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
      // Sanitize: reject absolute paths and path traversal
      if (relPath.startsWith('/') || relPath.includes('..')) {
        continue; // skip dangerous paths silently
      }
      const fullPath = join(hostDir, relPath);
      // Ensure subdirectories exist
      const dir = fullPath.slice(0, fullPath.lastIndexOf('/'));
      if (dir && dir !== hostDir) {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(fullPath, content, 'utf-8');
    }
  }

  private async ensureImage(image: string): Promise<void> {
    await ensureImageAvailable(image);
  }

  /**
   * Read files written by the container to /tmp/output/.
   * Returns a map of relative paths → UTF-8 content.
   * Enforces a total-bytes budget (50MB) to prevent excessive memory usage.
   */
  private async readOutputFiles(
    hostOutputDir: string,
  ): Promise<Record<string, string> | undefined> {
    try {
      const entries = await readdir(hostOutputDir, { withFileTypes: true });
      if (entries.length === 0) return undefined;

      const files: Record<string, string> = {};
      const maxFileSize = 10_000_000; // 10MB per file
      const maxTotalBytes = 50_000_000; // 50MB total budget across all files
      const maxFiles = 50;
      let count = 0;
      let totalBytes = 0;

      for (const entry of entries) {
        if (count >= maxFiles) break;
        if (totalBytes >= maxTotalBytes) break;
        if (!entry.isFile()) continue;

        const filePath = join(hostOutputDir, entry.name);
        const fileStat = await stat(filePath);
        if (fileStat.size > maxFileSize) continue; // skip oversized files

        try {
          const content = await readFile(filePath, 'utf-8');
          files[entry.name] = content;
          totalBytes += fileStat.size;
          count++;
        } catch {
          // skip binary files that can't be read as UTF-8
        }
      }

      return Object.keys(files).length > 0 ? files : undefined;
    } catch {
      return undefined;
    }
  }

  private async runContainer(
    request: ContainerRunRequest,
    containerName: string,
    startTime: number,
    hostFilesDir?: string,
    hostOutputDir?: string,
  ): Promise<ContainerRunResult> {
    // Pre-pull image quietly so docker run stderr stays clean
    await this.ensureImage(request.image);

    const args = [
      'run',
      '--rm',
      '--name',
      containerName,
      // Security isolation
      '--network',
      request.networkMode,
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=256m',
      '--user',
      '1000:1000',
      '--no-healthcheck',
      // Resource limits
      '--memory',
      request.memory,
      '--cpus',
      request.cpus,
      ...sandboxPidsLimitArgs(),
      // No privilege escalation
      '--security-opt',
      'no-new-privileges:true',
      '--cap-drop',
      'ALL',
      // Timeout: Docker-level kill after timeout + 5s grace
      '--stop-timeout',
      String(request.timeoutSeconds),
    ];

    // Bind-mount input files read-only
    if (hostFilesDir) {
      args.push('-v', `${hostFilesDir}:/tmp/input:ro`);
    }

    // Bind-mount output directory — agent writes files here to return them
    if (hostOutputDir) {
      args.push('-v', `${hostOutputDir}:/tmp/output:rw`);
    }

    if (request.workspace) {
      args.push('-v', `${request.workspace.hostDir}:/workspace:rw`);
    }

    // Environment variables
    if (request.env) {
      for (const [key, value] of Object.entries(request.env)) {
        // Sanitize: reject keys with special characters
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          args.push('-e', `${key}=${value}`);
        }
      }
    }

    // Image and command
    args.push(request.image, ...request.command);

    return new Promise<ContainerRunResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let killed = false;

      const child = spawn('docker', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 0, // We handle timeout ourselves
      });

      // External abort: kill the container so the `docker run` child exits, its
      // close handler fires, and the executor slot is freed — rather than the
      // job staying parked (and the container running detached) until the inner
      // timeout. The kill makes docker exit non-zero; the result reflects that.
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        spawn('docker', ['kill', containerName], { stdio: 'ignore' });
      };
      const signal = request.signal;
      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      // Executor-side timeout (belt-and-suspenders with Docker's --stop-timeout)
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        // First try graceful stop
        spawn('docker', ['stop', '-t', '2', containerName], { stdio: 'ignore' });
        // Force kill after 5s if still running
        setTimeout(() => {
          if (!killed) {
            spawn('docker', ['kill', containerName], { stdio: 'ignore' });
          }
        }, 5000);
      }, request.timeoutSeconds * 1000);

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdoutBytes < MAX_CAPTURE_BYTES) {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrBytes < MAX_CAPTURE_BYTES) {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        }
      });

      const childEe = childAsEmitter(child);
      childEe.on('close', (code: number | null) => {
        killed = true;
        clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener('abort', onAbort);

        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        const durationMs = Date.now() - startTime;

        const abortNote = aborted && !timedOut ? `\n[Execution aborted; container killed]` : '';
        resolve({
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout,
          stderr: timedOut
            ? `${stderr}\n[Execution timed out after ${String(request.timeoutSeconds)}s${
                request.timeoutTeaching ? ` — ${request.timeoutTeaching}` : ''
              }]`
            : `${stderr}${abortNote}`,
          durationMs,
          timedOut,
        });
      });

      childEe.on('error', (err: Error) => {
        killed = true;
        clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener('abort', onAbort);
        const durationMs = Date.now() - startTime;
        resolve({
          exitCode: 127,
          stdout: '',
          stderr: `Failed to launch container: ${err.message}`,
          durationMs,
          timedOut: false,
        });
      });
    });
  }
}
