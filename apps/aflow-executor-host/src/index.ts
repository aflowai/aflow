/**
 * Host Executor — the operator's own machine, paired to a local appliance.
 *
 * Runs as the ordinary OS user rather than in the appliance image, because
 * reaching their real projects, installed toolchains and devices is the whole
 * point of it and a container cannot. It is an executor in the ordinary sense:
 * the same `ExecutorRuntime`, the same job stream, the same result contract.
 * What differs is where it runs and what confines a job once it starts.
 *
 * The host's own policy file is a ceiling. Authority is the intersection of it
 * and the grant that arrives with the job, so a job cannot widen a binding by
 * asking, and a compromised appliance cannot invent one.
 */
import './instrument.js';

import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  ExecutorRuntime,
  DEFAULT_EXECUTOR_CONFIG,
  createServiceLogger,
  type ExecutorDependencies,
} from '@aflow/executor-runtime';
import type { Redis } from 'ioredis';
import { createShutdownController, attachSignalHandlers } from '@aflow/lib';
import { resolvePayloadStore } from '@aflow/payload-store';
import {
  attachRedisErrorGuard,
  closeRedisConnection,
  createBlockingRedisConnection,
  getExecutorRedisConfig,
  type RedisConfig,
  getRedisConnection,
  HOST_INVENTORY_REFRESH_MS,
  HOST_INVENTORY_TTL_SECONDS,
  HOST_MACHINES_KEY,
  HOST_WITHDRAWAL_CHANNEL,
  hostInventoryKey,
  type HostInventory,
  type HostWithdrawalNotice,
  quitRedisWithTimeout,
} from '@aflow/redis';
import { ConsumerGroups, StreamKeys } from '@aflow/schemas';

import { executionPermitted, loadHostPolicy } from './bindings.js';
import { removeWorktree } from './worktree.js';
import { removeOrphanedCheckouts } from './handlers/harnessHandlers.js';
import { createHostHandler } from './handlers/hostHandler.js';
import {
  allSessions,
  discardScratch,
  dropSessionsForBinding,
  withdrawnSessions,
} from './harnessSessions.js';
import { discardNow, openOrphanJournal, reapOrphans } from './orphans.js';
import { loadPairedEnv } from './pairedEnv.js';
import { watchPolicy } from './policyWatch.js';
import { killAllProcesses, killProcessesForBinding, reapWithdrawn } from './sandboxedRun.js';
import { observeRuntimes } from './runtimes.js';
import { pushPostures } from './pushApproval.js';
import { createBackgroundTaskRunner } from '@aflow/lib';

const log = createServiceLogger('host-executor');

const STEP_TYPE = 'host';

/** Twice the refresh, so one missed cycle does not blank a live machine. */

/**
 * Outside any path a job can write, so a job cannot grant itself a binding by
 * editing the file that lists them.
 */
function resolvePolicyPath(): string {
  const configured = process.env['PHOENIX_HOST_POLICY_PATH']?.trim();
  if (configured !== undefined && configured !== '') return configured;
  // The same directory `pair`, `connect` and the harness CLI write to. Reading
  // it only from home while those honoured an override meant a machine set up
  // in a custom directory was paired, connected, and invisible: the executor
  // started cleanly against an unrelated policy and refused every binding.
  const dir = process.env['PHOENIX_HOST_DIR']?.trim();
  if (dir !== undefined && dir !== '') return join(dir, 'host-policy.json');
  return join(homedir(), '.aflow', 'host-policy.json');
}

const CREDENTIAL_RETRY_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000];

/**
 * Block until the server accepts this machine's credential, saying so each time
 * it does not. A paired identity the server has lost is the one failure the
 * executor cannot repair from its side, and an executor that exits on it sits
 * dead until someone restarts it — while the appliance keeps asserting the
 * identity at every boot. Waiting, loudly, turns that into a delay.
 */
export async function waitForRedisCredential(
  config: RedisConfig,
  logger: { error: (msg: string, meta?: Record<string, unknown>) => void },
  connect: (name: string, cfg: RedisConfig) => Redis = createBlockingRedisConnection,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const probe = connect(`host-executor-credential-probe-${String(process.pid)}`, config);
    try {
      await probe.ping();
      return;
    } catch (error) {
      const delay =
        CREDENTIAL_RETRY_MS[Math.min(attempt, CREDENTIAL_RETRY_MS.length - 1)] ?? 60_000;
      logger.error(
        "Redis refused this machine's credential; the paired identity is missing or changed. Retrying.",
        {
          attempt: attempt + 1,
          retryInMs: delay,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      await sleep(delay);
    } finally {
      await quitRedisWithTimeout(probe).catch(() => undefined);
    }
  }
}

async function main(): Promise<void> {
  const hostname = process.env['HOSTNAME'] ?? `host-executor-${String(process.pid)}`;
  const policyPath = resolvePolicyPath();

  // Before anything reads the environment for a connection. Pairing wrote the
  // credential here; not reading it left the executor resolving Redis from
  // ambient state and falling through to a default.
  const paired = loadPairedEnv(dirname(policyPath));

  if (paired.shadowed.length > 0) {
    log.warn(
      'The environment already set values this machine was paired with, so the paired ones were ' +
        'not used. Pointed at another instance the executor starts cleanly and claims nothing, ' +
        'which looks from the appliance exactly like a lane that is down.',
      { shadowed: paired.shadowed.join(',') },
    );
  }

  await waitForRedisCredential(getExecutorRedisConfig(), log);
  const redis = getRedisConnection(getExecutorRedisConfig());
  const redisBlocking = createBlockingRedisConnection(
    `${hostname}-blocking`,
    getExecutorRedisConfig(),
  );

  // No in-memory fallback: a payload store that forgets is indistinguishable
  // from one that works until something reads back, and Phase 1 asks for an
  // actionable readiness error rather than a fake success.
  const resolved = resolvePayloadStore({ redis, allowMemory: false });
  if (resolved === null) {
    throw new Error(
      'No durable payload store is configured. The host executor shares the appliance ' +
        'payload volume; set PHOENIX_PAYLOAD_DIR to the path it is mounted at.',
    );
  }

  log.info('Starting Host Executor', {
    policyPath,
    payloadStore: resolved.reason,
    ...(paired.applied.length > 0 ? { pairedEnv: paired.applied.join(',') } : { paired: false }),
  });

  const deps: ExecutorDependencies = { redis, redisBlocking, payloadStore: resolved.store };

  const runtime = new ExecutorRuntime(
    {
      ...DEFAULT_EXECUTOR_CONFIG,
      consumerName: hostname,
      consumerGroup: ConsumerGroups.executor(STEP_TYPE),
      streamKey: StreamKeys.jobStream(STEP_TYPE),
      stepType: STEP_TYPE,
      concurrency: parseInt(process.env['EXECUTOR_CONCURRENCY'] ?? '4', 10),
      defaultTimeoutMs: parseInt(process.env['DEFAULT_TIMEOUT_MS'] ?? '300000', 10),
    },
    deps,
  );

  // Before the first job: anything a previous executor left running is holding
  // a credential nothing can address any more, so it is ended rather than
  // adopted. A handle that lived only in memory cannot be recovered, and
  // pretending otherwise would be worse than ending the process.
  const journal = openOrphanJournal(dirname(policyPath));
  const reaped = reapOrphans(journal);
  if (reaped > 0) {
    log.warn('Ended processes left behind by a previous run of this executor', {
      count: reaped,
    });
  }

  // Checkouts too: every session died with the previous executor, so what they
  // held on disk and in the operator's repositories has nothing left that would
  // ever expire it.
  const bound = await loadHostPolicy(policyPath)
    .then((policy) => [...policy.bindings.values()].map((binding) => binding.root))
    .catch(() => undefined);
  const orphaned = await removeOrphanedCheckouts(bound);
  const checkouts = [...orphaned.removed.values()].reduce((sum, count) => sum + count, 0);
  if (checkouts > 0 || orphaned.scratchDirs > 0) {
    log.info('Removed checkouts left behind by a previous run of this executor', {
      checkouts,
      folders: [...orphaned.removed.keys()],
      scratchDirs: orphaned.scratchDirs,
    });
  }

  runtime.registerHandler(createHostHandler(policyPath));

  // Withdrawal reaches running work without waiting for the next request. A
  // detached command exists so the step can end, so ordinarily no request
  // comes — and the operator would wait out a timeout instead.
  const policyWatch = watchPolicy(policyPath, () => {
    void loadHostPolicy(policyPath)
      .then(async (policy) => {
        const permitted = executionPermitted(policy.bindings);
        const killed = reapWithdrawn(permitted);
        // Sessions too. A process is the loud half of a withdrawal; a session
        // is the quiet one — idle, holding a checkout of the operator's code
        // and the harness's state, and reachable again the moment the binding
        // came back. Reaping only processes left that checkout on disk until
        // another harness request or a shutdown.
        const dropped = withdrawnSessions(permitted);
        for (const session of dropped) {
          await removeWorktree(session.bindingRoot, session.worktreePath).catch(() => undefined);
          await discardScratch(session);
        }
        if (killed.length > 0 || dropped.length > 0) {
          log.warn('Ended work under a binding this machine no longer grants', {
            processes: killed.length,
            sessions: dropped.length,
          });
        }
      })
      .catch((error: unknown) => {
        // A policy that is gone is the strongest withdrawal there is: the file
        // is the machine's half of every grant, and without it nothing running
        // is authorised by anything. Treating that as a no-op left detached
        // work holding its access indefinitely, because the operations that
        // fail closed were never going to arrive.
        //
        // A policy that is present but unreadable is a different thing — most
        // often a half-written file between a temp write and its rename — and
        // killing live work over a partial read would make an ordinary save
        // destructive. That one waits for the next event.
        if (!existsSync(policyPath)) {
          const killed = killAllProcesses();
          log.warn('The host policy is gone; ended everything it had authorised', {
            count: killed,
          });
          return;
        }
        log.warn('Could not read the host policy after it changed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });

  // A detached process is spawned into its own group so a stop reaches its
  // descendants, which also means it survives this executor unless something
  // ends it. One holding a credential in its environment, unaddressable because
  // the handles live only in memory, is the worst of both.
  for (const signal of ['SIGINT', 'SIGTERM', 'exit'] as const) {
    process.once(signal, () => {
      policyWatch.close();
      killAllProcesses();
      // Synchronous, deliberately. An `exit` handler schedules no further work,
      // so a promise-based removal here never ran and every session's checkout
      // was left on disk. Handles live in memory, so after this nothing can
      // address these — they are unreachable copies of the operator's code.
      for (const session of allSessions()) discardNow(session.scratchDir);
    });
  }

  await runtime.start();
  log.info('Host executor runtime started', { stepType: STEP_TYPE });

  // Last known good, so a policy read that fails mid-save does not publish an
  // empty list — "this machine offers no harness" and "the file was being
  // written" are different facts, and only the first should reach a workspace.
  let lastHarnesses: HostInventory['harnesses'] = [];
  let lastFolders: HostInventory['folders'] = [];

  // Published with a lifetime rather than stored: an inventory that outlives the
  // executor describes a machine nobody is listening on, and inviting a run
  // against a tool that may no longer be there is worse than saying nothing.
  // Refreshed on the same cadence, so it disappears shortly after the executor
  // does.
  const publishRuntimes = async (): Promise<void> => {
    const runtimes = await observeRuntimes();
    // From the policy rather than from discovery: an installed harness the
    // operator never added to the file cannot be addressed by a run, so naming
    // it here would offer work that is refused.
    const { harnesses, folders } = await loadHostPolicy(policyPath)
      .then((policy) => ({
        harnesses: [...policy.harnesses.values()]
          .map((profile) => ({
            id: profile.id,
            ...(profile.label !== undefined ? { label: profile.label } : {}),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        folders: pushPostures(policy.bindings),
      }))
      .catch(() => ({ harnesses: lastHarnesses, folders: lastFolders }));
    lastHarnesses = harnesses;
    lastFolders = folders;
    const inventory: HostInventory = {
      hostname,
      observedAt: new Date().toISOString(),
      runtimes,
      harnesses,
      folders,
    };
    await redis.setex(
      hostInventoryKey(hostname),
      HOST_INVENTORY_TTL_SECONDS,
      JSON.stringify(inventory),
    );
    // Announced into a small set rather than left to be scanned for. Finding
    // work by walking the keyspace is what [[180]] forbids, and the appliance
    // has no other way to learn a machine's name.
    //
    // Scored by when it was last heard from, not merely present: a member
    // only leaves on a clean shutdown, and the default name carries this
    // process's pid, so every crash-and-restart used to add one more name
    // that nothing would ever remove. The reader drops what has aged out, so
    // the cost of listing machines follows the live ones.
    await redis.zadd(HOST_MACHINES_KEY, Date.now(), hostname);
  };
  // Through the shared runner rather than a bare `setInterval`: cycles cannot
  // overlap when a runtime probe or Redis stalls, and it inherits the jitter,
  // budget, abort and error backoff every declared task is supposed to have.
  // [[180]] asks for exactly this, and a task added after the rule was written
  // has no excuse for being the exception.
  const inventoryTask = createBackgroundTaskRunner(
    {
      taskId: 'host.runtime_inventory',
      scope: 'per_instance',
      intervalMs: HOST_INVENTORY_REFRESH_MS,
      maxBatch: 1,
      maxCycleMs: 30_000,
      mode: 'enabled',
      runImmediately: true,
      logger: {
        debug: (message, data) => {
          log.debug(message, data);
        },
        info: (message, data) => {
          log.info(message, data);
        },
        warn: (message, data) => {
          log.warn(message, data);
        },
        error: (message, error, data) => {
          log.error(message, { error, ...data });
        },
      },
    },
    async () => {
      await publishRuntimes();
      return { processed: 1 };
    },
  );
  inventoryTask.start();

  // A withdrawal decided on the appliance reaches work already running here.
  //
  // The machine's policy file stays the authority on what may START — nothing
  // arriving over this channel can widen anything. What it can do is end a
  // detached command or drop an idle session, which is exactly the gap: the row
  // is gone, no further step will be scheduled, and the process that was already
  // running holds the folder until it decides to exit.
  const withdrawals = createBlockingRedisConnection(
    `${hostname}-withdrawals`,
    getExecutorRedisConfig(),
  );
  await withdrawals.subscribe(HOST_WITHDRAWAL_CHANNEL).catch((error: unknown) => {
    log.warn('Could not subscribe to withdrawals; they will apply at the next policy change', {
      error,
    });
  });
  withdrawals.on('message', (_channel: string, raw: string) => {
    void (async () => {
      let notice: HostWithdrawalNotice;
      try {
        notice = JSON.parse(raw) as HostWithdrawalNotice;
      } catch {
        return;
      }
      if (typeof notice.hostBindingId !== 'string' || notice.hostBindingId === '') return;
      const killed = killProcessesForBinding(notice.hostBindingId);
      const dropped = dropSessionsForBinding(notice.hostBindingId);
      for (const session of dropped) {
        await removeWorktree(session.bindingRoot, session.worktreePath).catch(() => undefined);
        await discardScratch(session);
      }
      if (killed.length > 0 || dropped.length > 0) {
        log.warn('Ended work under a binding the workspace withdrew', {
          bindingId: notice.hostBindingId,
          processes: killed.length,
          sessions: dropped.length,
        });
      }
    })();
  });

  const controller = createShutdownController({
    name: 'Host Executor',
    logger: log,
    onShutdown: async () => {
      await inventoryTask.stop();
      await redis.zrem(HOST_MACHINES_KEY, hostname).catch(() => undefined);
      await runtime.stop();
      await quitRedisWithTimeout(withdrawals);
      await quitRedisWithTimeout(redisBlocking);
      await closeRedisConnection();
    },
  });

  attachRedisErrorGuard(redis, () => controller.shuttingDown, log);
  attachRedisErrorGuard(redisBlocking, () => controller.shuttingDown, log);
  attachSignalHandlers({ onShutdown: () => controller.shutdownOnce(), exitCode: 0 });
}

main().catch((error: unknown) => {
  log.error('Failed to start Host Executor', { error });
  process.exit(1);
});
