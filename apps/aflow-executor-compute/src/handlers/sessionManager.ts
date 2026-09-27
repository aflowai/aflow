import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, readdir, readFile, writeFile, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { TenantId, SessionId } from '@aflow/schemas';
import { backgroundTaskControlPlane } from '@aflow/schemas';
import { createBackgroundTaskRunner, type BackgroundTaskRunner } from '@aflow/lib';
import type { ExecutorLogger } from '@aflow/executor-runtime';

import {
  type ContainerRunResult,
  MAX_CAPTURE_BYTES,
  sandboxPidsLimitArgs,
} from './containerRunner.js';
import { ensureImageAvailable } from '../ensureImage.js';
import type { WorkspaceQuotas } from './workspaceManager.js';
import { sandboxScratchDir } from './sandboxHostDir.js';

// ============================================================================
// Types
// ============================================================================

/** Session key: one session per tenant+run combination. */
export type SessionKey = `${TenantId}:${SessionId}`;

export function makeSessionKey(tenantId: TenantId, runId: SessionId): SessionKey {
  return `${tenantId}:${runId}`;
}

export interface SessionConfig {
  /** Docker image to use */
  image: string;
  /** Memory limit (Docker format, e.g. '4096m') */
  memory: string;
  /** CPU limit (Docker format, e.g. '2') */
  cpus: string;
  /** Environment variables for the container */
  env?: Record<string, string> | undefined;
  /** Input files to mount (path → content) */
  files?: Record<string, string> | undefined;
  /** Idle TTL in seconds (container reaped after this idle period) */
  idleTtlSeconds: number;
  /** Max session lifetime in seconds (hard cap) */
  maxLifetimeSeconds: number;
  networkConfig?: { networkAccess: boolean; allowedHosts: string[] } | undefined;
  workspace?:
    | {
        hostDir: string;
        spaceId: string;
        quotas: WorkspaceQuotas;
      }
    | undefined;
}

export interface SessionHandle {
  key: SessionKey;
  containerId: string;
  containerName: string;
  /** How this session was obtained */
  restoreSource: 'warm' | 'checkpoint' | 'fresh';
  /** When the session was first created */
  createdAt: number;
  /** Files persisted from checkpoint restore (if any) */
  restoredFiles?: string[];
}

/** Checkpoint: saved files from a reaped session, stored on disk. */
interface SessionCheckpoint {
  key: SessionKey;
  outputDir: string; // Host path to saved /tmp/output/ files
  createdAt: number; // When the original session was created
  checkpointedAt: number; // When the checkpoint was taken
  ttlSeconds: number; // How long to keep the checkpoint
}

/** Internal session state tracked in memory. */
interface SessionEntry {
  key: SessionKey;
  containerId: string;
  containerName: string;
  /** The persistent phoenix-runner.py process (attached via docker exec -i) */
  runnerProcess: ChildProcess | undefined;
  /** Host-side directory for output files */
  hostOutputDir: string;
  /** Session config (for recreation) */
  config: SessionConfig;
  /** When the session was created */
  createdAt: number;
  /** Last time code was executed in this session */
  lastActivityAt: number;
  /** Effective idle TTL */
  idleTtlSeconds: number;
  /** Effective max lifetime */
  maxLifetimeSeconds: number;
  /** Reserved memory in MB (for admission control) */
  reservedMemoryMb: number;
  /** Reserved CPU cores (for admission control) */
  reservedCpuCores: number;
  /** Lock: prevents concurrent exec on the same session */
  busy: boolean;
  networkConfig?: { networkAccess: boolean; allowedHosts: string[] } | undefined;
  workspace?:
    | {
        hostDir: string;
        spaceId: string;
        quotas: WorkspaceQuotas;
      }
    | undefined;
}

export interface SessionLifecycleHooks {
  beforeDestroy?: (payload: SessionDestroyPayload) => Promise<void>;
}

export interface SessionDestroyPayload {
  key: SessionKey;
  reason: 'release' | 'idle' | 'max_lifetime' | 'shutdown';
  workspace?:
    | {
        hostDir: string;
        spaceId: string;
        quotas: WorkspaceQuotas;
      }
    | undefined;
}

/** Sentinel line emitted by phoenix-runner.py after each response. */
const SENTINEL = '__PHOENIX_DONE__';

/** Max time to wait for the runner to become ready (ms). */
const RUNNER_READY_TIMEOUT_MS = 30_000;

/** Max time to wait for container creation (ms). */
const CONTAINER_CREATE_TIMEOUT_MS = 30_000;

/** Reaper interval (ms). */
export const REAPER_INTERVAL_MS = 60_000;

const REAPER_TASK_ID = 'executor.compute.session_reaper';

/** Max output files per session read. */
const MAX_OUTPUT_FILES = 50;
const MAX_OUTPUT_FILE_SIZE = 10_000_000; // 10MB per file
const MAX_TOTAL_OUTPUT_BYTES = 50_000_000; // 50MB total

// ============================================================================
// SessionManager
// ============================================================================

export interface SessionManagerOptions {
  log: ExecutorLogger;
  /** Max total memory across all sessions (MB). Default: 12288 (12GB). */
  maxTotalMemoryMb?: number;
  /** Max total CPU across all sessions. Default: 6. */
  maxTotalCpuCores?: number;
  /** Max concurrent sessions. Default: 5. */
  maxSessions?: number;
  lifecycleHooks?: SessionLifecycleHooks;
}

export class SessionManager {
  private readonly sessions = new Map<SessionKey, SessionEntry>();
  private readonly checkpoints = new Map<SessionKey, SessionCheckpoint>();
  private readonly log: ExecutorLogger;
  private readonly maxTotalMemoryMb: number;
  private readonly maxTotalCpuCores: number;
  private readonly maxSessions: number;
  private reaper: BackgroundTaskRunner | undefined;
  private lifecycleHooks: SessionLifecycleHooks;

  constructor(opts: SessionManagerOptions) {
    this.log = opts.log;
    this.maxTotalMemoryMb = opts.maxTotalMemoryMb ?? 12288;
    this.maxTotalCpuCores = opts.maxTotalCpuCores ?? 6;
    this.maxSessions = opts.maxSessions ?? 5;
    this.lifecycleHooks = opts.lifecycleHooks ?? {};
  }

  setLifecycleHooks(hooks: SessionLifecycleHooks): void {
    this.lifecycleHooks = hooks;
  }

  // ==========================================================================
  // Acquire: get or create a warm session
  // ==========================================================================

  async acquire(key: SessionKey, config: SessionConfig): Promise<SessionHandle> {
    // Fast path: warm container exists
    const existing = this.sessions.get(key);
    if (existing) {
      // Check if container is still alive
      const alive = await this.isContainerAlive(existing.containerName);
      if (alive) {
        existing.lastActivityAt = Date.now();
        this.log.info('Session acquired (warm)', {
          key,
          containerName: existing.containerName,
          ageSeconds: Math.floor((Date.now() - existing.createdAt) / 1000),
        });
        return {
          key,
          containerId: existing.containerId,
          containerName: existing.containerName,
          restoreSource: 'warm',
          createdAt: existing.createdAt,
        };
      }
      // Container died unexpectedly — clean up entry
      this.log.warn('Session container died unexpectedly', {
        key,
        containerName: existing.containerName,
      });
      await this.cleanupEntry(existing);
      this.sessions.delete(key);
    }

    // Check for cold checkpoint
    const checkpoint = this.checkpoints.get(key);
    if (checkpoint) {
      const checkpointAge = (Date.now() - checkpoint.checkpointedAt) / 1000;
      if (checkpointAge < checkpoint.ttlSeconds) {
        // Restore from checkpoint
        this.log.info('Restoring session from checkpoint', {
          key,
          checkpointAge: Math.floor(checkpointAge),
        });
        const handle = await this.createSession(key, config);

        // Restore files from checkpoint
        const restoredFiles = await this.restoreCheckpointFiles(
          handle.containerName,
          checkpoint.outputDir,
        );
        handle.restoreSource = 'checkpoint';
        handle.createdAt = checkpoint.createdAt;
        handle.restoredFiles = restoredFiles;

        // Clean up checkpoint
        this.checkpoints.delete(key);
        await rm(checkpoint.outputDir, { recursive: true, force: true }).catch(() => {});

        return handle;
      }
      // Checkpoint expired
      this.checkpoints.delete(key);
      await rm(checkpoint.outputDir, { recursive: true, force: true }).catch(() => {});
    }

    // Fresh session
    return this.createSession(key, config);
  }

  // ==========================================================================
  // Exec: send code to the persistent Python process
  // ==========================================================================

  async exec(
    key: SessionKey,
    code: string,
    timeoutSeconds: number,
    files?: Record<string, string>,
    inputMode: 'replace' | 'append' = 'replace',
    timeoutTeaching?: string,
  ): Promise<ContainerRunResult> {
    const entry = this.sessions.get(key);
    if (!entry) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'Session not found. It may have expired.',
        durationMs: 0,
        timedOut: false,
      };
    }

    if (entry.busy) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'Session is busy with another execution. Wait for it to complete.',
        durationMs: 0,
        timedOut: false,
      };
    }

    entry.busy = true;
    const startTime = Date.now();

    try {
      // Inject input files into the running container for this exec call
      if (files && Object.keys(files).length > 0) {
        await this.injectFilesIntoContainer(entry.containerName, files, inputMode);
      } else if (inputMode === 'replace') {
        // No new files but replace mode — clear stale inputs from prior turns
        await this.clearInputDirectory(entry.containerName);
      }

      // Ensure the runner process is alive
      let runner = entry.runnerProcess;
      if (runner?.exitCode != null) {
        this.log.info('Runner process not alive, starting new one', { key });
        runner = await this.startRunnerProcess(entry.containerName);
        entry.runnerProcess = runner;
      }

      const result = await this.sendToRunner(runner!, code, timeoutSeconds, timeoutTeaching);

      entry.lastActivityAt = Date.now();

      // Collect output files
      const outputFiles = await this.readOutputFiles(entry.hostOutputDir);

      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - startTime,
        timedOut: result.timedOut,
        outputFiles,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      this.log.error('Session exec failed', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Session exec error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs,
        timedOut: false,
      };
    } finally {
      entry.busy = false;
    }
  }

  // ==========================================================================
  // Release: checkpoint and destroy a specific session
  // ==========================================================================

  async release(key: SessionKey, checkpointTtlSeconds?: number): Promise<void> {
    const entry = this.sessions.get(key);
    if (!entry) return;

    await this.fireBeforeDestroy(entry, 'release');

    if (checkpointTtlSeconds && checkpointTtlSeconds > 0) {
      await this.checkpointSession(entry, checkpointTtlSeconds);
    }

    await this.destroySession(entry);
    this.sessions.delete(key);
  }

  // ==========================================================================
  // Reaper: reap expired sessions
  // ==========================================================================

  async reapExpired(maxBatch: number = Number.POSITIVE_INFINITY): Promise<number> {
    const now = Date.now();
    let reaped = 0;

    for (const [key, entry] of this.sessions) {
      if (reaped >= maxBatch) break;
      const idleSeconds = (now - entry.lastActivityAt) / 1000;
      const lifetimeSeconds = (now - entry.createdAt) / 1000;

      const expired =
        idleSeconds > entry.idleTtlSeconds || lifetimeSeconds > entry.maxLifetimeSeconds;

      if (expired) {
        const reason: 'idle' | 'max_lifetime' =
          idleSeconds > entry.idleTtlSeconds ? 'idle' : 'max_lifetime';
        this.log.info('Reaping expired session', {
          key,
          idleSeconds: Math.floor(idleSeconds),
          lifetimeSeconds: Math.floor(lifetimeSeconds),
          reason,
        });

        await this.fireBeforeDestroy(entry, reason);

        // Checkpoint before destroying
        await this.checkpointSession(entry, entry.idleTtlSeconds * 2);
        await this.destroySession(entry);
        this.sessions.delete(key);
        reaped++;
      }
    }

    // Also reap expired checkpoints
    for (const [key, checkpoint] of this.checkpoints) {
      const age = (now - checkpoint.checkpointedAt) / 1000;
      if (age > checkpoint.ttlSeconds) {
        this.log.debug('Removing expired checkpoint', { key });
        this.checkpoints.delete(key);
        await rm(checkpoint.outputDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    return reaped;
  }

  // ==========================================================================
  // Lifecycle: start/stop reaper
  // ==========================================================================

  startReaper(): void {
    if (this.reaper) return;
    // Tearing down a container is unbounded work inside a fixed interval, so a
    // raw timer stacks cycles that are all destroying the same sessions. The
    // runner starts the next cycle only once this one has settled.
    const runtime = backgroundTaskControlPlane().resolve(REAPER_TASK_ID);
    this.reaper = createBackgroundTaskRunner(
      {
        taskId: REAPER_TASK_ID,
        scope: runtime.scope,
        intervalMs: runtime.intervalMs ?? REAPER_INTERVAL_MS,
        maxBatch: runtime.maxBatch,
        maxCycleMs: runtime.maxCycleMs,
        mode: runtime.mode,
        logger: {
          debug: (message, data) => {
            this.log.debug(message, data);
          },
          info: (message, data) => {
            this.log.info(message, data);
          },
          warn: (message, data) => {
            this.log.warn(message, data);
          },
          error: (message, error, data) => {
            this.log.error(message, { ...data, ...(error ? { error: error.message } : {}) });
          },
        },
      },
      async (ctx) => {
        if (ctx.mode === 'observe') return {};
        const processed = await this.reapExpired(ctx.maxBatch);
        return { candidates: this.sessions.size, processed };
      },
    );
    this.reaper.start();
  }

  stopReaper(): void {
    const reaper = this.reaper;
    this.reaper = undefined;
    void reaper?.stop();
  }

  /** Graceful shutdown: checkpoint and destroy all sessions. */
  async shutdownAll(): Promise<void> {
    this.stopReaper();

    const keys = [...this.sessions.keys()];
    this.log.info('Shutting down all sessions', { count: keys.length });

    await Promise.all(
      keys.map(async (key) => {
        try {
          const entry = this.sessions.get(key);
          if (entry) {
            await this.fireBeforeDestroy(entry, 'shutdown');
            // Don't bother checkpointing on shutdown — Python-process state
            // won't survive executor restart anyway.
            await this.destroySession(entry);
            this.sessions.delete(key);
          }
        } catch (err: unknown) {
          this.log.error('Error destroying session during shutdown', {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    // Clean up checkpoints
    for (const [key, checkpoint] of this.checkpoints) {
      this.checkpoints.delete(key);
      await rm(checkpoint.outputDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ==========================================================================
  // Session info: for output
  // ==========================================================================

  getSessionInfo(key: SessionKey):
    | {
        sessionActive: boolean;
        sessionAge: number;
        remainingIdleTtlSeconds: number;
        persistedFiles?: string[];
      }
    | undefined {
    const entry = this.sessions.get(key);
    if (!entry) return undefined;

    const now = Date.now();
    const idleSeconds = (now - entry.lastActivityAt) / 1000;

    return {
      sessionActive: true,
      sessionAge: Math.floor((now - entry.createdAt) / 1000),
      remainingIdleTtlSeconds: Math.max(0, Math.floor(entry.idleTtlSeconds - idleSeconds)),
    };
  }

  getSessionWorkspace(
    key: SessionKey,
  ): { hostDir: string; spaceId: string; quotas: WorkspaceQuotas } | undefined {
    const entry = this.sessions.get(key);
    return entry?.workspace;
  }

  // ==========================================================================
  // Admission control
  // ==========================================================================

  canAdmit(memoryMb: number, cpuCores: number): { allowed: boolean; reason?: string } {
    if (this.sessions.size >= this.maxSessions) {
      return {
        allowed: false,
        reason: `Max concurrent sessions reached (${String(this.maxSessions)})`,
      };
    }

    let totalMemory = 0;
    let totalCpu = 0;
    for (const entry of this.sessions.values()) {
      totalMemory += entry.reservedMemoryMb;
      totalCpu += entry.reservedCpuCores;
    }

    if (totalMemory + memoryMb > this.maxTotalMemoryMb) {
      return {
        allowed: false,
        reason: `Insufficient memory: ${String(totalMemory)}/${String(this.maxTotalMemoryMb)} MB used, need ${String(memoryMb)} MB`,
      };
    }

    if (totalCpu + cpuCores > this.maxTotalCpuCores) {
      return {
        allowed: false,
        reason: `Insufficient CPU: ${String(totalCpu)}/${String(this.maxTotalCpuCores)} cores used, need ${String(cpuCores)} cores`,
      };
    }

    return { allowed: true };
  }

  /**
   * Validate that the requested network config matches the session's fixed config.
   * Network config is set at session creation and cannot change.
   * Returns an error message if mismatched, undefined if OK.
   */
  validateNetworkConfig(
    key: SessionKey,
    requestedNetworkAccess: boolean,
    requestedHosts: string[] | undefined,
  ): string | undefined {
    const entry = this.sessions.get(key);
    if (!entry) return undefined; // No session — will be created fresh

    const sessionNet = entry.networkConfig;
    if (!sessionNet && !requestedNetworkAccess) return undefined; // Both no-network

    if (requestedNetworkAccess && !sessionNet?.networkAccess) {
      return (
        'This session was created without network access. ' +
        'Network config is fixed at session creation. Start a new session to change network settings.'
      );
    }

    if (!requestedNetworkAccess && sessionNet?.networkAccess) {
      return (
        'This session was created with network access enabled. ' +
        'Network config is fixed at session creation — cannot disable mid-session.'
      );
    }

    // Both have network — check host mismatch
    if (sessionNet?.networkAccess && requestedNetworkAccess) {
      const sessionHosts = new Set(sessionNet.allowedHosts);
      const reqHosts = requestedHosts ?? [];
      const mismatched = reqHosts.filter((h) => !sessionHosts.has(h));
      if (mismatched.length > 0) {
        return (
          `Session was created with allowedHosts: [${sessionNet.allowedHosts.join(', ')}]. ` +
          `Cannot add new hosts mid-session: ${mismatched.join(', ')}. ` +
          'Start a new session to change network settings.'
        );
      }
    }

    return undefined;
  }

  validateWorkspaceConfig(
    key: SessionKey,
    requestedEnabled: boolean,
    requestedSpaceId: string | undefined,
  ): string | undefined {
    const entry = this.sessions.get(key);
    if (!entry) return undefined; // no live session — handler will hydrate fresh

    const hasWorkspace = entry.workspace !== undefined;

    if (requestedEnabled && !hasWorkspace) {
      return (
        'This session was created without workspace mode. ' +
        'Workspace is fixed at session creation. Start a new run (or wait for the ' +
        'session to be reaped) to enable workspace.'
      );
    }
    if (!requestedEnabled && hasWorkspace) {
      return (
        'This session was created with workspace mode enabled. ' +
        'Workspace is fixed at session creation — cannot disable mid-session.'
      );
    }
    if (
      requestedEnabled &&
      hasWorkspace &&
      requestedSpaceId !== undefined &&
      entry.workspace?.spaceId !== requestedSpaceId
    ) {
      return (
        `Session workspace was created for spaceId ${entry.workspace?.spaceId ?? 'unknown'}; ` +
        `cannot switch to ${requestedSpaceId} mid-session.`
      );
    }
    return undefined;
  }

  /** Number of active sessions. */
  get activeCount(): number {
    return this.sessions.size;
  }

  // ==========================================================================
  // Private: container lifecycle
  // ==========================================================================

  private async createSession(key: SessionKey, config: SessionConfig): Promise<SessionHandle> {
    // Admission control
    const memoryMb = parseInt(config.memory.replace('m', ''), 10) || 512;
    const cpuCores = parseFloat(config.cpus) || 1;
    const admission = this.canAdmit(memoryMb, cpuCores);
    if (!admission.allowed) {
      throw new Error(`Session admission denied: ${admission.reason}`);
    }

    const containerName = `phoenix-session-${randomUUID().slice(0, 12)}`;
    const now = Date.now();

    // Prepare host-side output dir. Bind-mounted at /tmp/output — must live under
    // the shared sandbox base dir so the path resolves identically in the executor
    // and the host Docker daemon (DinD invariant, see sandboxHostDir.ts).
    const hostOutputDir = sandboxScratchDir(`phoenix-session-output-${randomUUID().slice(0, 12)}`);
    await mkdir(hostOutputDir, { recursive: true });
    await chmod(hostOutputDir, 0o777);

    // Ensure image is available
    await this.ensureImage(config.image);

    // docker create (not run — no --rm, container persists)
    const createArgs = [
      'create',
      '--name',
      containerName,
      // Security isolation (same as ephemeral, except no --rm)
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=256m',
      '--user',
      '1000:1000',
      '--no-healthcheck',
      '--security-opt',
      'no-new-privileges:true',
      '--cap-drop',
      'ALL',
      // Resource limits
      '--memory',
      config.memory,
      '--cpus',
      config.cpus,
      ...sandboxPidsLimitArgs(),
      // Bind-mount output dir
      '-v',
      `${hostOutputDir}:/tmp/output:rw`,
    ];

    if (config.workspace) {
      createArgs.push('-v', `${config.workspace.hostDir}:/workspace:rw`);
    }

    // Note: input files are NOT bind-mounted in session mode.
    // They are injected via docker cp on each exec() call, allowing
    // new files to be added on subsequent turns without restart.

    // Environment variables
    if (config.env) {
      for (const [envKey, value] of Object.entries(config.env)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) {
          createArgs.push('-e', `${envKey}=${value}`);
        }
      }
    }

    // Image + long-running sleep command (keeps container alive)
    createArgs.push(config.image, 'sleep', 'infinity');

    // Create container
    const containerId = await this.dockerCommand(createArgs, CONTAINER_CREATE_TIMEOUT_MS);
    const trimmedId = containerId.trim();

    // Start container
    await this.dockerCommand(['start', containerName], CONTAINER_CREATE_TIMEOUT_MS);

    // Inject initial input files via docker cp (if any)
    if (config.files && Object.keys(config.files).length > 0) {
      await this.injectFilesIntoContainer(containerName, config.files);
    }

    // Start the persistent runner process
    let runnerProcess: ChildProcess | undefined;
    try {
      runnerProcess = await this.startRunnerProcess(containerName);
    } catch (err: unknown) {
      // Cleanup on failure
      await this.dockerCommand(['rm', '-f', containerName], 5000).catch(() => {});
      await rm(hostOutputDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    const entry: SessionEntry = {
      key,
      containerId: trimmedId,
      containerName,
      runnerProcess,
      hostOutputDir,
      config,
      createdAt: now,
      lastActivityAt: now,
      idleTtlSeconds: config.idleTtlSeconds,
      maxLifetimeSeconds: config.maxLifetimeSeconds,
      reservedMemoryMb: memoryMb,
      reservedCpuCores: cpuCores,
      busy: false,
      networkConfig: config.networkConfig,
      workspace: config.workspace,
    };

    this.sessions.set(key, entry);

    this.log.info('Session created', {
      key,
      containerName,
      image: config.image,
      memoryMb,
      cpuCores,
      idleTtlSeconds: config.idleTtlSeconds,
    });

    return {
      key,
      containerId: trimmedId,
      containerName,
      restoreSource: 'fresh',
      createdAt: now,
    };
  }

  /** Start the persistent phoenix-runner.py process inside the container. */
  private async startRunnerProcess(containerName: string): Promise<ChildProcess> {
    const child = spawn(
      'docker',
      ['exec', '-i', containerName, 'python3', '/opt/phoenix/runner.py'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    // Wait for the ready signal
    return new Promise<ChildProcess>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Runner process did not become ready within timeout'));
      }, RUNNER_READY_TIMEOUT_MS);

      let buffer = '';

      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('utf-8');
        if (buffer.includes(SENTINEL)) {
          clearTimeout(timeout);
          child.stdout.removeListener('data', onData);
          resolve(child);
        }
      };

      child.stdout.on('data', onData);

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to start runner: ${err.message}`));
      });

      child.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Runner exited prematurely with code ${String(code)}`));
      });
    });
  }

  /** Send code to the runner process and read the result. */
  private async sendToRunner(
    runner: ChildProcess,
    code: string,
    timeoutSeconds: number,
    timeoutTeaching?: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      const { stdin, stdout: runnerStdout, stderr: runnerStderr } = runner;
      if (!stdin || !runnerStdout || !runnerStderr) {
        reject(new Error('Runner process streams not available'));
        return;
      }

      let responseBuffer = '';
      let stderrBuffer = '';
      let resolved = false;
      const execStart = Date.now();

      const timeout = setTimeout(() => {
        // Kill just the running code, not the runner itself — by sending a SIGINT
        // to the docker exec process. Since the runner catches SystemExit, this should
        // interrupt the currently executing code.
        runner.kill('SIGINT');
        // Give it a moment, then resolve with timeout
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve({
              exitCode: 124,
              stdout: '',
              stderr: `[Execution timed out after ${String(timeoutSeconds)}s${
                timeoutTeaching ? ` — ${timeoutTeaching}` : ''
              }]`,
              timedOut: true,
            });
          }
        }, 2000);
      }, timeoutSeconds * 1000);

      const onStdout = (chunk: Buffer): void => {
        if (resolved) return;
        responseBuffer += chunk.toString('utf-8');

        // Check for sentinel
        const sentinelIndex = responseBuffer.indexOf(SENTINEL + '\n');
        if (sentinelIndex !== -1) {
          resolved = true;
          clearTimeout(timeout);
          cleanup();

          // Everything before the sentinel is the response
          const responsePart = responseBuffer.slice(0, sentinelIndex).trim();

          try {
            const result = JSON.parse(responsePart) as {
              exitCode: number;
              stdout: string;
              stderr: string;
            };
            resolve({
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr + stderrBuffer,
              timedOut: false,
            });
          } catch {
            resolve({
              exitCode: 1,
              stdout: responsePart,
              stderr: stderrBuffer || 'Failed to parse runner response',
              timedOut: false,
            });
          }
        }

        // Safety: prevent unbounded buffer growth
        if (responseBuffer.length > MAX_CAPTURE_BYTES) {
          resolved = true;
          clearTimeout(timeout);
          cleanup();
          resolve({
            exitCode: 1,
            stdout: '',
            stderr: 'Response too large — exceeded capture limit',
            timedOut: false,
          });
        }
      };

      const onStderr = (chunk: Buffer): void => {
        if (stderrBuffer.length < MAX_CAPTURE_BYTES) {
          stderrBuffer += chunk.toString('utf-8');
        }
      };

      const onError = (err: Error): void => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          cleanup();
          reject(new Error(`Runner process error: ${err.message}`));
        }
      };

      const onExit = (code: number | null): void => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          cleanup();

          // Detect if the exit happened near the timeout boundary — likely a timeout kill
          const elapsed = (Date.now() - execStart) / 1000;
          const nearTimeout = elapsed >= timeoutSeconds * 0.9;
          if (nearTimeout) {
            resolve({
              exitCode: 124,
              stdout: '',
              stderr: `[Execution killed after ~${String(Math.round(elapsed))}s — exceeded the ${String(timeoutSeconds)}s timeout${
                timeoutTeaching ? `; ${timeoutTeaching}` : ''
              }]`,
              timedOut: true,
            });
          } else {
            reject(
              new Error(
                `Runner process exited unexpectedly with code ${String(code)} after ${Math.round(elapsed)}s` +
                  (stderrBuffer ? `: ${stderrBuffer.slice(0, 500)}` : ''),
              ),
            );
          }
        }
      };

      const cleanup = (): void => {
        runnerStdout.removeListener('data', onStdout);
        runnerStderr.removeListener('data', onStderr);
        runner.removeListener('error', onError);
        runner.removeListener('exit', onExit);
      };

      runnerStdout.on('data', onStdout);
      runnerStderr.on('data', onStderr);
      runner.on('error', onError);
      runner.on('exit', onExit);

      // Send the request
      const request = JSON.stringify({ code }) + '\n';
      stdin.write(request, (err) => {
        if (err && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          cleanup();
          reject(new Error(`Failed to write to runner stdin: ${err.message}`));
        }
      });
    });
  }

  // ==========================================================================
  // Private: checkpoint & restore
  // ==========================================================================

  private async checkpointSession(entry: SessionEntry, ttlSeconds: number): Promise<void> {
    try {
      // Save output files from host output dir
      const checkpointDir = sandboxScratchDir(`phoenix-checkpoint-${randomUUID().slice(0, 12)}`);
      await mkdir(checkpointDir, { recursive: true });

      // Copy output files from the host output dir to checkpoint
      const files = await readdir(entry.hostOutputDir).catch(() => [] as string[]);
      for (const file of files) {
        try {
          const src = join(entry.hostOutputDir, file);
          const dst = join(checkpointDir, file);
          const content = await readFile(src);
          await writeFile(dst, content);
        } catch {
          // skip files that can't be read
        }
      }

      const checkpoint: SessionCheckpoint = {
        key: entry.key,
        outputDir: checkpointDir,
        createdAt: entry.createdAt,
        checkpointedAt: Date.now(),
        ttlSeconds,
      };

      this.checkpoints.set(entry.key, checkpoint);

      this.log.info('Session checkpointed', {
        key: entry.key,
        fileCount: files.length,
        ttlSeconds,
      });
    } catch (err: unknown) {
      this.log.error('Failed to checkpoint session', {
        key: entry.key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async restoreCheckpointFiles(
    containerName: string,
    checkpointDir: string,
  ): Promise<string[]> {
    const restored: string[] = [];
    try {
      const files = await readdir(checkpointDir);
      for (const file of files) {
        try {
          // docker cp checkpoint files into the container's /tmp/output/
          const src = join(checkpointDir, file);
          await this.dockerCommand(['cp', src, `${containerName}:/tmp/output/${file}`], 10_000);
          restored.push(file);
        } catch {
          // skip files that can't be copied
        }
      }
      this.log.info('Checkpoint files restored', {
        containerName,
        fileCount: restored.length,
      });
    } catch (err: unknown) {
      this.log.error('Failed to restore checkpoint files', {
        containerName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return restored;
  }

  // ==========================================================================

  private async fireBeforeDestroy(
    entry: SessionEntry,
    reason: 'release' | 'idle' | 'max_lifetime' | 'shutdown',
  ): Promise<void> {
    if (!this.lifecycleHooks.beforeDestroy) return;
    try {
      await this.lifecycleHooks.beforeDestroy({
        key: entry.key,
        reason,
        workspace: entry.workspace,
      });
    } catch (err: unknown) {
      // Hook errors are logged but never block destruction. Workspace
      // contents may be lost; that's preferable to leaking containers.
      this.log.error('Session beforeDestroy hook failed', {
        key: entry.key,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ==========================================================================
  // Private: container operations
  // ==========================================================================

  private async destroySession(entry: SessionEntry): Promise<void> {
    // Kill the runner process
    if (entry.runnerProcess) {
      try {
        entry.runnerProcess.kill('SIGKILL');
      } catch {
        // already dead
      }
    }

    // Stop and remove container
    await this.dockerCommand(['rm', '-f', entry.containerName], 10_000).catch(() => {});

    // Clean up host-side output dir
    await rm(entry.hostOutputDir, { recursive: true, force: true }).catch(() => {});

    this.log.info('Session destroyed', {
      key: entry.key,
      containerName: entry.containerName,
      lifetimeSeconds: Math.floor((Date.now() - entry.createdAt) / 1000),
    });
  }

  private async cleanupEntry(entry: SessionEntry): Promise<void> {
    if (entry.runnerProcess) {
      try {
        entry.runnerProcess.kill('SIGKILL');
      } catch {
        // already dead
      }
    }
    // Try to remove the container (may already be gone)
    await this.dockerCommand(['rm', '-f', entry.containerName], 5000).catch(() => {});
    await rm(entry.hostOutputDir, { recursive: true, force: true }).catch(() => {});
  }

  private async isContainerAlive(containerName: string): Promise<boolean> {
    try {
      const output = await this.dockerCommand(
        ['inspect', '-f', '{{.State.Running}}', containerName],
        5000,
      );
      return output.trim() === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Inject files into a running container's /tmp/input/ directory.
   *
   * Cannot use `docker cp` because the container has `--read-only` rootfs
   * and Docker refuses `docker cp` even to writable tmpfs mounts.
   *
   * Instead, pipes a tar archive through `docker exec` which runs INSIDE
   * the container where /tmp is a writable tmpfs. This handles both
   * initial file injection and subsequent turns.
   */
  /** Clear /tmp/input/ in a running container. */
  private async clearInputDirectory(containerName: string): Promise<void> {
    await this.dockerCommand(
      ['exec', containerName, 'sh', '-c', 'rm -rf /tmp/input && mkdir -p /tmp/input'],
      10_000,
    );
  }

  private async injectFilesIntoContainer(
    containerName: string,
    files: Record<string, string>,
    inputMode: 'replace' | 'append' = 'replace',
  ): Promise<void> {
    const tmpDir = sandboxScratchDir(`phoenix-inject-${randomUUID().slice(0, 12)}`);
    try {
      await this.writeInputFiles(tmpDir, files);

      const entries = await readdir(tmpDir);
      if (entries.length === 0) return;

      // Pipe a tar archive through docker exec to extract inside the container.
      // This bypasses the --read-only rootfs check because tar runs inside
      // the container where /tmp is a writable tmpfs mount.
      // In 'replace' mode, clear existing files first to prevent stale data.
      // In 'append' mode, inject on top of existing files (overwrite on collision).
      const extractCmd =
        inputMode === 'replace'
          ? 'rm -rf /tmp/input && mkdir -p /tmp/input && tar -xf - -C /tmp/input'
          : 'mkdir -p /tmp/input && tar -xf - -C /tmp/input';
      await new Promise<void>((resolve, reject) => {
        // Create tar on host, pipe into docker exec tar -xf inside container
        const tar = spawn('tar', ['-cf', '-', '-C', tmpDir, '.'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const extract = spawn('docker', ['exec', '-i', containerName, 'sh', '-c', extractCmd], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Pipe tar stdout → docker exec stdin
        tar.stdout.pipe(extract.stdin);

        let stderr = '';
        extract.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf-8');
        });

        const timeout = setTimeout(() => {
          tar.kill();
          extract.kill();
          reject(new Error('File injection timed out after 60s'));
        }, 60_000);

        extract.on('close', (code: number | null) => {
          clearTimeout(timeout);
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`File injection failed (exit ${String(code)}): ${stderr}`));
          }
        });

        extract.on('error', (err: Error) => {
          clearTimeout(timeout);
          reject(new Error(`File injection error: ${err.message}`));
        });

        tar.on('error', (err: Error) => {
          clearTimeout(timeout);
          extract.kill();
          reject(new Error(`Tar creation error: ${err.message}`));
        });
      });

      this.log.debug('Injected files into session container', {
        containerName,
        fileCount: entries.length,
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async ensureImage(image: string): Promise<void> {
    await ensureImageAvailable(image);
  }

  private async writeInputFiles(hostDir: string, files: Record<string, string>): Promise<void> {
    await mkdir(hostDir, { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
      if (relPath.startsWith('/') || relPath.includes('..')) continue;
      const fullPath = join(hostDir, relPath);
      const dir = fullPath.slice(0, fullPath.lastIndexOf('/'));
      if (dir && dir !== hostDir) {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(fullPath, content, 'utf-8');
    }
  }

  /** Run a docker command and return stdout. Throws on non-zero exit. */
  private dockerCommand(args: string[], timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        'docker',
        args,
        { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`docker ${args[0]} failed: ${stderr || (err as Error).message}`));
          } else {
            resolve(stdout);
          }
        },
      );
    });
  }

  /** Read output files from the host output dir (same logic as DockerRunner). */
  private async readOutputFiles(
    hostOutputDir: string,
  ): Promise<Record<string, string> | undefined> {
    try {
      const entries = await readdir(hostOutputDir, { withFileTypes: true });
      if (entries.length === 0) return undefined;

      const files: Record<string, string> = {};
      let count = 0;
      let totalBytes = 0;

      for (const entry of entries) {
        if (count >= MAX_OUTPUT_FILES) break;
        if (totalBytes >= MAX_TOTAL_OUTPUT_BYTES) break;
        if (!entry.isFile()) continue;

        const filePath = join(hostOutputDir, entry.name);
        const fileStat = await stat(filePath);
        if (fileStat.size > MAX_OUTPUT_FILE_SIZE) continue;

        try {
          const content = await readFile(filePath, 'utf-8');
          totalBytes += fileStat.size;
          files[entry.name] = content;
          count++;
        } catch {
          // skip binary files
        }
      }

      return Object.keys(files).length > 0 ? files : undefined;
    } catch {
      return undefined;
    }
  }
}
