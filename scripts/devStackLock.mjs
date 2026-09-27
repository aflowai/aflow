/**
 * One dev stack per machine, refused rather than raced.
 *
 * Two stacks from two checkouts do not merely compete for ports 3000/3001 —
 * they attach to the same Redis and join the *same consumer group*, where they
 * load-balance each other's work. A run started against one executes on
 * whichever claimed the message, and a second stack given different ports would
 * still do that while looking healthy. So there is no port to move to, and the
 * check keys on the processes rather than on the listener.
 *
 * Same machine is a property of the thing, not an assumption: `dev:local` binds
 * loopback and both stacks read a Redis on 127.0.0.1, so a pid is a pid either
 * checkout observes. That is what makes the refusal able to name the other
 * worktree instead of reporting that something, somewhere, holds a port.
 */
import { execSync } from 'node:child_process';

/** Profiles carrying neither of these compose no orchestrator and collide with nothing. */
const CONFLICTING_SERVICES = ['orchestrator', 'server'];

/**
 * How a process announces which stack it belongs to. The supervisors matter as
 * much as the workers: killing the workers alone leaves a supervisor that
 * restarts them, which is why `yarn kill` appeared not to work.
 */
const STACK_PROCESS_PATTERNS = [
  { kind: 'supervisor', pattern: /scripts\/dev-local\.ts/ },
  { kind: 'supervisor', pattern: /scripts\/dev\.mjs --profile (\S+)/ },
  { kind: 'orchestrator', pattern: /apps\/aflow-orchestrator\/(?:src|dist)\/index/ },
];

/**
 * The checkout a command line belongs to, or undefined when no absolute path in
 * it names one. Derived from the first repository-internal path: a worktree is
 * whatever lies above `node_modules`, `scripts`, `apps` or `packages`.
 */
export function worktreeOfCommand(command) {
  const match = /(\/\S+?)\/(?:node_modules|scripts|apps|packages)\//.exec(command);
  return match?.[1];
}

/**
 * Parse `ps ax -o pid=,command=` into the stack processes it contains.
 *
 * Pure, so the shapes that actually occur — a supervisor whose worktree is only
 * spelled in a `--require` flag, an mcp profile that must not count — are pinned
 * by tests rather than discovered on a machine that already has two stacks.
 */
export function parseStackProcesses(psOutput, options = {}) {
  const ignored = new Set((options.ignorePids ?? []).map(Number));
  const found = [];
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (ignored.has(pid)) continue;

    for (const { kind, pattern } of STACK_PROCESS_PATTERNS) {
      const hit = pattern.exec(command);
      if (hit === null) continue;
      // A `--profile mcp` supervisor is deliberately allowed to run beside a
      // stack — it composes no orchestrator, and the MCP is expected to outlive
      // restarts.
      if (hit[1] !== undefined && !profileConflicts(hit[1])) break;
      found.push({ pid, kind, worktree: worktreeOfCommand(command), command });
      break;
    }
  }
  return found;
}

/** Whether a profile name composes anything a second stack would fight over. */
export function profileConflicts(profileName, profiles) {
  if (profiles === undefined) return profileName !== 'mcp';
  const services = profiles[profileName];
  if (services === undefined) return false;
  return services.some((service) => CONFLICTING_SERVICES.includes(service));
}

/**
 * The refusal, or undefined when nothing conflicts.
 *
 * Names the other worktree and the pids, because "port 3000 is in use" sends
 * the reader to `lsof`, which answers with a pid in a directory they then have
 * to identify. It also says why a different port is not the remedy: the
 * collision people see is the port, and the one that corrupts a run is the
 * consumer group.
 */
export function stackConflictMessage(processes, options = {}) {
  if (processes.length === 0) return undefined;
  const command = options.command ?? 'this stack';

  const named = [...new Set(processes.map((p) => p.worktree).filter((w) => w !== undefined))];
  const where = named.length > 0 ? named.join(' and ') : 'another checkout on this machine';
  const pids = processes.map((p) => p.pid).join(' ');

  return [
    `A dev stack is already running from ${where}.`,
    '',
    "Two stacks share this machine's Redis, so they join the same consumer group and",
    "split each other's work: a run started in one browser tab executes in the other",
    'stack, against whatever instance identity that checkout was given. Different ports',
    'would not separate them — the ports are the visible half of the collision.',
    '',
    `Stop the other one:  yarn kill     (its processes: ${pids})`,
    `Then run:            ${command}`,
  ].join('\n');
}

/**
 * A running process's working directory, for the supervisors whose command line
 * spells every path relative — `node scripts/dev.mjs --profile local` names no
 * checkout at all, and "a stack is running somewhere" is the message this guard
 * exists to replace.
 */
function cwdOfPid(pid) {
  try {
    const out = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.split('\n').find((l) => l.startsWith('n'));
    return line === undefined ? undefined : line.slice(1).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse `ps ax -o pid=,ppid=` into a child→parent map.
 *
 * Separate from the command parse because the whole ancestor chain has to be
 * known before any of it can be excluded, and only the pid columns matter here.
 */
export function parseParentMap(psOutput) {
  const parents = new Map();
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match === null) continue;
    parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

/**
 * This process and every process above it, up to init.
 *
 * The immediate parent is not enough, and assuming it was made a clean
 * `yarn dev:local` refuse itself: the supervisor that matches
 * `scripts/dev-local.ts` sits three levels up, behind the `tsx` preflight
 * process that is the direct parent, so the invocation detected its own
 * launcher as somebody else's stack.
 */
export function ancestorPids(parents, startPid) {
  const chain = [startPid];
  let current = startPid;
  // Bounded rather than while-true: a corrupt map could otherwise cycle, and a
  // guard that hangs is worse than one that misses.
  for (let hop = 0; hop < 64; hop += 1) {
    const parent = parents.get(current);
    if (parent === undefined || parent === 0 || parent === current) break;
    chain.push(parent);
    if (parent === 1) break;
    current = parent;
  }
  return chain;
}

/** Stack processes running on this machine, excluding this process and its ancestry. */
export function findRunningStack(options = {}) {
  let psOutput = '';
  let parentOutput = '';
  try {
    psOutput = execSync('ps ax -o pid=,command=', {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    parentOutput = execSync('ps ax -o pid=,ppid=', {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // A machine that will not answer `ps` is not one to refuse a start on: the
    // guard exists to explain a collision, never to be the reason nothing runs.
    return [];
  }
  const own = ancestorPids(parseParentMap(parentOutput), process.pid);
  const found = parseStackProcesses(psOutput, {
    ignorePids: [...own, ...(options.ignorePids ?? [])],
  });
  return found.map((entry) =>
    entry.worktree === undefined ? { ...entry, worktree: cwdOfPid(entry.pid) } : entry,
  );
}
