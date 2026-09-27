/**
 * The Redis ACL the appliance starts with.
 *
 * Two identities, because two very different processes connect. Every service
 * inside the appliance is platform code on a private network and authenticates
 * as `default`. The paired host executor runs on the operator's machine, over a
 * loopback-published port, and gets a grant narrow enough that a stolen
 * credential is worth little.
 *
 * The grant is derived from what `packages/executor-runtime` actually issues,
 * measured rather than guessed, and it bounds the *credential* rather than the
 * process — a same-user process on the operator's machine can read the file
 * holding it, which is what the OS boundary is for and this is not.
 *
 * What it does bound is checkable, and Phase 0 checked it: the control stream,
 * the session state hash, another lane's job stream, write-approval grants,
 * `KEYS` and `FLUSHALL` are all refused. Redis 7 applies these key rules inside
 * Lua as well, including for keys a script never declares, which is why the
 * appliance pins that major version rather than tracking latest.
 *
 * One limit is inherent and disclosed: ACL key patterns are static while step,
 * session and consumer ids are dynamic, so the grant admits a key *family* and
 * never this executor's own member of it.
 */

/**
 * Categories minus the dangerous individuals, rather than an enumeration.
 *
 * An enumerated list couples the grant to how a helper happens to be written:
 * `registerExecutorHeartbeat` issues `SETEX`, not `SET` plus `EXPIRE`, and a
 * list derived from helper names refuses it at the first heartbeat. The key
 * patterns below are the real boundary — a command it cannot name a key for
 * reaches nothing — so the command list only has to exclude what is dangerous
 * regardless of key: enumerating the keyspace, emptying it, reconfiguring the
 * server, or inspecting other connections.
 *
 * `@scripting` stays because Lua is how several helpers do their compare-and-set,
 * and Redis 7 applies these same key rules inside a script, including to keys it
 * never declares.
 */
const HOST_COMMANDS = [
  // Everything, minus what is dangerous regardless of which key it names.
  //
  // Enumerating what the executor uses was tried twice and failed twice: first
  // from helper names, which missed `SETEX`; then from categories, which missed
  // `@transaction` and `@pubsub`. Each miss authenticated, claimed a job and
  // then failed somewhere else, and each was found by reading `ACL LOG` rather
  // than by reasoning.
  //
  // The key patterns below are what actually bounds this identity — a command
  // that cannot name a permitted key reaches nothing — so the command list only
  // has to remove the commands whose damage does not depend on a key at all:
  // enumerating or emptying the keyspace, reconfiguring the server, reading
  // other connections, or replicating elsewhere.
  //
  // `INFO` is deliberately not among them. ioredis runs a ready check on every
  // connection and that check is an `INFO`, so withholding it does not withhold
  // anything from the executor — it breaks the client library's handshake and
  // degrades to a warning the operator would have to know to look for.
  '+@all',
  '-keys',
  '-scan',
  '-randomkey',
  '-flushall',
  '-flushdb',
  '-swapdb',
  '-config',
  '-shutdown',
  '-debug',
  '-client',
  // …but not the subcommand a client uses to name itself. `CLIENT SETINFO`
  // writes this connection's own library label and reads nothing; `CLIENT LIST`
  // and `CLIENT KILL`, which is what `-client` is really for, stay refused.
  '+client|setinfo',
  '+client|setname',
  '-cluster',
  '-acl',
  '-monitor',
  '-replicaof',
  '-slaveof',
  '-failover',
  '-migrate',
  '-module',
  '-reset',
  '-save',
  '-bgsave',
  '-bgrewriteaof',
  '-latency',
  '-slowlog',
  '-memory',
] as const;

/** Key families the executor touches, and no others. */
const HOST_KEY_PATTERNS = [
  '~aflow:jobs:host',
  '~aflow:shard:*:results',
  '~aflow:step:*:state',
  '~aflow:step-inflight:*',
  '~aflow:session_events:*',
  '~aflow:executor-heartbeat:*',
  '~aflow:idempotency:*',
  // Armed on every ack: a lane whose acked frontier moved is exactly the stream
  // whose retention has to notice ([[294]]). Without it the executor authenticates,
  // claims a job, and aborts the transaction that records the step as started.
  '~aflow:retention:candidates',
  // Cancellation, live output and step scratch: the runtime checks whether a
  // step was cancelled before and during work, streams deltas as it goes, and
  // keeps per-step scratch. Derived from the executor's import graph rather
  // than discovered one `NOPERM` at a time — `ACL LOG` names the key when this
  // list is wrong, which is how the last three were found.
  '~aflow:cancelled:*',
  '~aflow:live:*',
  '~aflow:step:*:scratch',
  // What the machine reports it has. Published by the executor, read by the
  // appliance, and expiring on its own so it never outlives the machine.
  '~aflow:host-inventory:*',
  '~aflow:host-machines',
  // A step a workflow dispatched has no session to wake; its executor puts the
  // live-delta wake on the task's own progress stream and indexes the stream,
  // the road the task's progress already travels.
  '~aflow:workflow_task_progress:*',
  '~aflow:workflow_task_progress_index',
  // Marked when a step reaches a terminal state, so the durable projection
  // knows there is something to flush. Armed inside the same transaction that
  // records the result, which is why a grant without it discards that write.
  '~aflow:projection:candidates',
  '~aflow:projection:order',
  // Step inputs and outputs, when the payload store is Redis — which it is
  // whenever object storage is not configured, and it is never configured on an
  // appliance. Without this the executor authenticates, claims a job, does the
  // work, and cannot write the result: every host step fails with NOPERM after
  // the side effect has already happened.
  //
  // This one hid behind the tests. An `inline:` ref carries its bytes in the
  // message and touches no key, so a handler exercised with inline input and a
  // small output never reaches the store — while a step dispatched by the
  // orchestrator always does.
  '~aflow:payload:*',
] as const;

/** Channels it subscribes to for aborts and session wakeups. */

const HOST_CHANNEL_PATTERNS = ['&aflow:pubsub:*', '&aflow:abort:*'] as const;

export interface RedisAclInput {
  /** Every in-appliance service authenticates with this. */
  defaultPassword: string;
  /** The paired host executor's credential. */
  hostPassword: string;
}

/**
 * Renders an `--aclfile`. `default` keeps full access because the services
 * behind it are platform code on a private network; what changes is that it
 * now needs a password at all, which the appliance previously did not.
 */
export function renderRedisAcl(input: RedisAclInput): string {
  // `resetpass` before the password, on both identities.
  //
  // `ACL SETUSER` ADDS a password; it does not replace one. Rotating a
  // credential by setting a new one therefore left the old one working, which
  // made `POST /v1/host/revoke` a control that reported success and revoked
  // nothing. Rendering the reset into the rule itself means every path that
  // applies it — the file at boot, a live rotation — replaces rather than
  // accumulates, instead of each caller having to remember.
  const host = [
    'user hostexec resetpass on',
    `>${input.hostPassword}`,
    ...HOST_KEY_PATTERNS,
    ...HOST_CHANNEL_PATTERNS,
    ...HOST_COMMANDS,
  ].join(' ');

  return [`user default resetpass on >${input.defaultPassword} ~* &* +@all`, host, ''].join('\n');
}

export const REDIS_ACL_FILENAME = 'redis-acl.conf';

/**
 * Make a rendered ACL take effect on a server that is already running.
 *
 * Redis reads `--aclfile` once, at startup. `instance-init` rewrites that file
 * on every deploy — it has to, because the passwords are derived from stored
 * values — but it runs before the server exists, and a deploy that leaves the
 * Redis container alone never re-reads it. So a grant added in one release was
 * enforced from the next time somebody happened to restart Redis, which is
 * indistinguishable from a code fault: the key patterns are right in the file,
 * in the source and in the test, and the live server answers NOPERM.
 *
 * `ACL LOAD` closes that. It is the same file, read again, so it cannot widen
 * anything beyond what the deploy already wrote — and failure is not fatal:
 * before the first start there is nothing to reload, and the file is read
 * anyway when the server comes up.
 */
/**
 * Apply the host identity to a running server, whatever it holds now.
 *
 * `ACL SETUSER` with `resetpass` replaces the password rather than adding one,
 * and the rendered line is the whole grant, so this is idempotent: a user that
 * is missing is created, one that drifted is corrected, one that is right is
 * left as it was. The pairing route rotates through it; the local boot
 * re-asserts through it, because on a server with no ACL file the identity
 * lives in memory and anything that deletes it — a test, a restart — would
 * otherwise leave the paired machine refused until someone noticed.
 */
export async function applyHostIdentityToRunningServer(
  redis: { call: (command: string, ...args: string[]) => Promise<unknown> },
  input: RedisAclInput,
): Promise<void> {
  const line = renderRedisAcl(input)
    .split('\n')
    .find((l) => l.startsWith('user hostexec'));
  if (line === undefined) throw new Error('Rendered ACL carries no host identity.');
  await redis.call('ACL', 'SETUSER', ...line.split(' ').slice(1));
}

export async function loadRedisAclIntoRunningServer(redis: {
  call: (command: string, ...args: string[]) => Promise<unknown>;
}): Promise<'loaded' | 'skipped'> {
  try {
    await redis.call('ACL', 'LOAD');
    return 'loaded';
  } catch {
    // A server without an `--aclfile` refuses this, and so does one that has
    // not started. Neither is a reason to fail a deploy.
    return 'skipped';
  }
}
