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

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { createServiceLogger } from '@aflow/executor-runtime';
import type { Redis } from 'ioredis';
import { createShutdownController } from '@aflow/lib';
import { resolvePayloadStore } from '@aflow/payload-store';
import {
  attachRedisErrorGuard,
  closeRedisConnection,
  createBlockingRedisConnection,
  getExecutorRedisConfig,
  type RedisConfig,
  getRedisConnection,
  getWriteApprovalGrant,
  HOST_INVENTORY_REFRESH_MS,
  HOST_INVENTORY_TTL_SECONDS,
  HOST_MACHINES_KEY,
  hostBrowserSignInChannel,
  HOST_WITHDRAWAL_CHANNEL,
  hostInventoryKey,
  type HostInventory,
  type HostInventoryBrowsers,
  type HostInventoryFolders,
  type HostWithdrawalNotice,
  quitRedisWithTimeout,
  readHostBrowserSignInRequest,
} from '@aflow/redis';

import { executionPermitted, loadHostPolicy } from './bindings.js';
import { createChromeLauncher } from './browser/chromeProcess.js';
import { BrowserDriver } from './browser/driver.js';
import type { SignInResult } from './browser/driverTypes.js';
import { startHandoffBoard } from './browser/handoffBoard.js';
import { createBrowserIdleSweep } from './browser/idleSweep.js';
import { followBrowserRequests } from './browser/requestPoll.js';
import { isBrowserRequestFile, serveBrowserRequests } from './browser/windowRequests.js';
import { createBrowserHandler } from './handlers/browserHandler.js';
import { removeWorktree } from './worktree.js';
import { removeOrphanedCheckouts } from './handlers/harnessHandlers.js';
import {
  BROWSER_STEP_TYPE,
  STEP_TYPE,
  createHostRuntimes,
  guardHostConnections,
} from './hostRuntimes.js';
import { createHostHandler } from './handlers/hostHandler.js';
import {
  allSessions,
  discardScratch,
  dropSessionsForBinding,
  withdrawnSessions,
} from './harnessSessions.js';
import { discardNow, openOrphanJournal, reapOrphans } from './orphans.js';
import { resolveHostPolicyPath } from './hostDir.js';
import { loadPairedEnv } from './pairedEnv.js';
import { followPolicy, watchPolicy } from './policyWatch.js';
import { killAllProcesses, killProcessesForBinding, reapWithdrawn } from './sandboxedRun.js';
import { observeRuntimes } from './runtimes.js';
import { publishingFolders } from './pushApproval.js';
import { startUnderSignals } from './startUnderSignals.js';
import { type BackgroundTaskLogger, createBackgroundTaskRunner } from '@aflow/lib';

const log = createServiceLogger('host-executor');

const taskLogger: BackgroundTaskLogger = {
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
};

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
  const policyPath = resolveHostPolicyPath();

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

  const host = createHostRuntimes({
    hostname,
    redis,
    payloadStore: resolved.store,
    connect: (name) => createBlockingRedisConnection(name, getExecutorRedisConfig()),
  });
  const { runtime, browserRuntime, hostChannels, connections } = host;

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
  const handoffs = await startHandoffBoard({
    redis,
    subscriber: hostChannels,
    hostDir: dirname(policyPath),
    machineLabel: hostname,
    log,
  });

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

  runtime.registerHandler(
    createHostHandler(policyPath, (tenantId, runId, requestHash) =>
      getWriteApprovalGrant(redis, tenantId, runId, requestHash),
    ),
  );

  // Loaded here rather than at the top so that nothing importing this module
  // for its helpers pulls in the browser automation library.
  const { createPlaywrightEngine } = await import('./browser/engine.js');
  const browserDriver = new BrowserDriver({
    engine: createPlaywrightEngine(),
    launcher: createChromeLauncher(),
    hostDir: dirname(policyPath),
    loadPolicy: async () => await loadHostPolicy(policyPath),
    handoffs,
  });
  browserRuntime.registerHandler(createBrowserHandler(browserDriver));
  const browserIdleSweep = createBrowserIdleSweep(browserDriver, taskLogger);

  // Last known good, so a policy read that fails mid-save does not publish an
  // empty list — "this machine offers no harness" and "the file was being
  // written" are different facts, and only the first should reach a workspace.
  let lastHarnesses: HostInventory['harnesses'] = [];
  let lastFolders: HostInventoryFolders = [];
  let lastBrowsers: HostInventoryBrowsers = [];

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
        folders: publishingFolders(policy.bindings),
      }))
      .catch(() => ({ harnesses: lastHarnesses, folders: lastFolders }));
    lastHarnesses = harnesses;
    lastFolders = folders;
    const browsers = await browserDriver
      .machineProfiles()
      .then((profiles) =>
        profiles.map(({ profile, running, windowShown, sites }) => ({
          id: profile.id,
          posture: profile.posture,
          window: profile.window,
          spaces: profile.spaces,
          rules: profile.rules,
          idleMinutes: profile.idleMinutes,
          running,
          windowOpen: windowShown,
          ...(sites !== undefined ? { sites } : {}),
        })),
      )
      .catch(() => lastBrowsers);
    lastBrowsers = browsers;
    const inventory: HostInventory = {
      hostname,
      observedAt: new Date().toISOString(),
      runtimes,
      harnesses,
      folders,
      browsers,
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
      logger: taskLogger,
    },
    async () => {
      await publishRuntimes();
      return { processed: 1 };
    },
  );

  // One sitting however the operator asked for it — `aflow browser sign-in` on
  // the machine, or Sign in to sites on the workspace's machine page. The
  // inventory is republished as the window opens and as it closes, which is
  // how that page learns of both.
  const republishInventory = (): void => {
    void inventoryTask.runOnce().catch(() => undefined);
  };
  const signInSitting = async (
    profileId: string,
    askedFrom: 'machine' | 'workspace',
  ): Promise<SignInResult> => {
    log.info('Showing a browser window for the operator to sign in', { profileId, askedFrom });
    try {
      return await browserDriver.signIn(profileId, { onShown: republishInventory });
    } finally {
      republishInventory();
    }
  };

  // `aflow browser` asks through files beside the policy, because the Chrome a
  // profile's directory allows is this executor's; see windowRequests.ts.
  const browserRequests = serveBrowserRequests(
    dirname(policyPath),
    async (request) => {
      if (request.kind === 'sign_in') {
        return { kind: 'sign_in', ...(await signInSitting(request.profileId, 'machine')) };
      }
      const profiles = await browserDriver.machineProfiles();
      return {
        kind: 'list',
        profiles: profiles.map(({ profile, running, sites }) => ({
          id: profile.id,
          running,
          ...(sites !== undefined ? { sites } : {}),
        })),
      };
    },
    (message, meta) => {
      log.warn(message, meta);
    },
  );

  // Withdrawal reaches running work without waiting for the next request. A
  // detached command exists so the step can end, so ordinarily no request
  // comes — and the operator would wait out a timeout instead.
  const onPolicyChange = (): void => {
    void loadHostPolicy(policyPath)
      .then(async (policy) => {
        await followPolicy({
          reapHostWork: async () => {
            const permitted = executionPermitted(policy);
            const killed = reapWithdrawn(permitted);
            // Sessions too. A process is the loud half of a withdrawal; a session
            // is the quiet one — idle, holding a checkout of the operator's code
            // and the harness's state, and reachable again the moment the binding
            // came back. Reaping only processes left that checkout on disk until
            // another harness request or a shutdown.
            const dropped = withdrawnSessions(permitted.bindings);
            for (const session of dropped) {
              await removeWorktree(session.bindingRoot, session.worktreePath).catch(
                () => undefined,
              );
              await discardScratch(session);
            }
            if (killed.length > 0 || dropped.length > 0) {
              log.warn('Ended work under a binding this machine no longer grants', {
                processes: killed.length,
                sessions: dropped.length,
              });
            }
          },
          followInBrowsers: async () => {
            await browserDriver.policyChanged(policy);
          },
          warn: (message, meta) => {
            log.warn(message, meta);
          },
        });
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
  };
  const policyWatch = watchPolicy(policyPath, onPolicyChange, undefined, {
    matches: isBrowserRequestFile,
    onChange: () => {
      void browserRequests.check();
    },
  });
  const browserRequestPoll = followBrowserRequests(
    browserRequests,
    policyWatch.watching,
    taskLogger,
  );

  // A detached process is spawned into its own group so a stop reaches its
  // descendants, which also means it survives this executor unless something
  // ends it. One holding a credential in its environment, unaddressable because
  // the handles live only in memory, is the worst of both. SIGTERM and SIGINT
  // run this at once: whatever sends them may SIGKILL seconds later, which
  // skips the exit handler below. Only a drain defers it, to its own end.
  const endEverything = (): void => {
    policyWatch.close();
    killAllProcesses();
    // Synchronous, deliberately. An `exit` handler schedules no further work,
    // so a promise-based removal here never ran and every session's checkout
    // was left on disk. Handles live in memory, so after this nothing can
    // address these — they are unreachable copies of the operator's code.
    for (const session of allSessions()) discardNow(session.scratchDir);
  };
  process.once('exit', endEverything);

  // A restart under the dev stack's watcher drains: a harness run, a check or a
  // review in flight is minutes of work the restart has no reason to end. The
  // browser's pages are not held open for it.
  let browserStopped: Promise<void> | undefined;
  const stopBrowserRuntime = (): Promise<void> => (browserStopped ??= browserRuntime.stop());

  const controller = createShutdownController({
    name: 'Host Executor',
    logger: log,
    drain: {
      work: {
        stopClaiming: () => {
          runtime.stopClaiming();
          void stopBrowserRuntime();
        },
        inFlight: () => runtime.inFlight(),
        whenInFlight: () => runtime.whenInFlight(),
        idle: () => runtime.idle(),
      },
      endInFlight: endEverything,
    },
    onShutdown: async () => {
      await inventoryTask.stop();
      await browserIdleSweep.stop();
      await browserRequestPoll.stop();
      await redis.zrem(HOST_MACHINES_KEY, hostname).catch(() => undefined);
      await runtime.stop();
      await stopBrowserRuntime();
      await quitRedisWithTimeout(connections.hostChannels);
      await quitRedisWithTimeout(connections.blocking);
      await quitRedisWithTimeout(connections.browserBlocking);
      await quitRedisWithTimeout(connections.browserChannels);
      await closeRedisConnection();
    },
  });

  attachRedisErrorGuard(redis, () => controller.shuttingDown, log);
  guardHostConnections(host, () => controller.shuttingDown, log);

  const started = await startUnderSignals(controller, [
    async () => {
      await runtime.start();
      log.info('Host executor runtime started', { stepType: STEP_TYPE });
    },
    async () => {
      await browserRuntime.start();
      log.info('Host executor runtime started', { stepType: BROWSER_STEP_TYPE });
    },
  ]);
  if (!started) return;

  inventoryTask.start();
  browserIdleSweep.start();
  browserRequestPoll.start();

  // A withdrawal decided on the appliance reaches work already running here.
  //
  // The machine's policy file stays the authority on what may START — nothing
  // arriving over this channel can widen anything. What it can do is end a
  // detached command or drop an idle session, which is exactly the gap: the row
  // is gone, no further step will be scheduled, and the process that was already
  // running holds the folder until it decides to exit.
  await hostChannels.subscribe(HOST_WITHDRAWAL_CHANNEL).catch((error: unknown) => {
    log.warn('Could not subscribe to withdrawals; they will apply at the next policy change', {
      error,
    });
  });
  // The operator asking from the workspace for a profile's sign-in window. It
  // opens a window on this machine and widens nothing: the sitting is the one
  // `aflow browser sign-in` holds, on a profile this machine declares.
  const signInChannel = hostBrowserSignInChannel(hostname);
  await hostChannels.subscribe(signInChannel).catch((error: unknown) => {
    log.warn('Could not subscribe to sign-in requests from the workspace', { error });
  });
  const signInAskedFromWorkspace = (raw: string): void => {
    const profileId = readHostBrowserSignInRequest(raw, hostname);
    if (profileId === undefined) return;
    signInSitting(profileId, 'workspace')
      .then((result) => {
        log.info('The operator closed the sign-in window', {
          profileId,
          outcome: result.outcome,
          sites: result.sites.length,
        });
      })
      .catch((error: unknown) => {
        log.warn('Could not show the sign-in window the workspace asked for', {
          profileId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };
  hostChannels.on('message', (channel: string, raw: string) => {
    if (channel === signInChannel) {
      signInAskedFromWorkspace(raw);
      return;
    }
    if (channel !== HOST_WITHDRAWAL_CHANNEL) return;
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
}

main().catch((error: unknown) => {
  log.error('Failed to start Host Executor', { error });
  process.exit(1);
});
