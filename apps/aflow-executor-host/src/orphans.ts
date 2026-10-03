/**
 * What survives this executor, and how it is found again.
 *
 * Every workload is spawned into its own process group so a stop reaches its
 * descendants. That is also what lets one outlive the executor: a group is not
 * killed because its parent died. A clean exit can kill them, but SIGKILL, an
 * out-of-memory kill or a power cut cannot be handled — and what is left behind
 * is a harness holding a provider credential in its environment, writing into a
 * checkout of the operator's code, addressable by nothing, because the handles
 * that named it lived only in memory.
 *
 * So the group ids are written down as they are created and the file is read at
 * startup. A process that predates this executor is not adopted — it could not
 * be, since its handle is gone — it is ended.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * One line per group: the pid, the scratch directory it was using, and enough
 * to tell whether the pid still names the process that was written down.
 */
interface OrphanRecord {
  readonly pid: number;
  /**
   * Removed with the process. Absent for one that keeps nothing disposable —
   * a browser's profile directory holds the operator's sign-ins and outlives
   * every process that uses it.
   */
  readonly scratchDir?: string;
  /** When this executor recorded it, in epoch milliseconds. */
  readonly recordedAt?: number;
}

let journalPath: string | undefined;

export function openOrphanJournal(hostDir: string): string {
  journalPath = join(hostDir, 'running.jsonl');
  mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
  return journalPath;
}

/** Recorded synchronously: a crash between spawning and writing loses the pid. */
export function recordSpawn(pid: number, scratchDir?: string): void {
  if (journalPath === undefined) return;
  try {
    appendFileSync(
      journalPath,
      `${JSON.stringify({ pid, ...(scratchDir !== undefined ? { scratchDir } : {}), recordedAt: Date.now() })}\n`,
      {
        mode: 0o600,
      },
    );
  } catch {
    // A journal that cannot be written is worth less than the run it would
    // describe; failing the run over it would be the wrong trade.
  }
}

export function readJournal(path: string): OrphanRecord[] {
  if (!existsSync(path)) return [];
  const records: OrphanRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as OrphanRecord).pid === 'number' &&
        Number.isInteger((parsed as OrphanRecord).pid) &&
        (parsed as OrphanRecord).pid > 1 &&
        ['string', 'undefined'].includes(typeof (parsed as OrphanRecord).scratchDir)
      ) {
        records.push(parsed as OrphanRecord);
      }
    } catch {
      // A truncated last line is what a crash mid-write looks like. The records
      // before it are still good.
    }
  }
  return records;
}

/**
 * Whether this pid is still the process that was written down.
 *
 * A pid is a name the operating system reuses. The journal outlives the
 * processes in it — that is its whole purpose — so by the time it is read, a
 * recorded number may belong to something the operator started since, and
 * signalling the *group* means their editor and everything it launched. That
 * turns a housekeeping step into the worst thing this lane could do to the
 * machine it runs on.
 *
 * Two questions, both cheap. Is it a group leader? Every workload here is
 * spawned detached, so its pid and group id are equal; a reused pid almost
 * never is one. Did it start before we recorded it? Then it cannot be the
 * process we spawned afterwards. Neither is conclusive alone and together they
 * are enough — and when the answer cannot be obtained at all, nothing is
 * killed, because a leaked process costs less than an operator's session.
 */
/**
 * How far a process's start time may sit from when it was recorded.
 *
 * Generous on purpose. The signal being looked for is pid reuse, which needs the
 * operating system's pid counter to wrap — a separation of hours or days, not
 * seconds. What a tight window catches instead is `lstart`'s one-second
 * resolution and the delay between a spawn and the journal write on a loaded
 * machine, and the cost of getting that wrong is refusing to reap a genuine
 * orphan that is holding a credential.
 */
export const START_TIME_TOLERANCE_MS = 120_000;

/** A live process's group and, where it could be read, when it started. */
export interface ProcessStart {
  readonly pgid: number;
  readonly startedAt?: number;
}

/** Nothing when the pid names no process or its start cannot be read. */
export type ProcessStartSource = (pid: number) => ProcessStart | undefined;

/** One line of `ps -o pgid=,lstart=`. */
export function parseProcessStart(line: string): ProcessStart | undefined {
  const [pgidText, ...rest] = line.trim().split(/\s+/);
  const pgid = Number(pgidText);
  if (pgidText === undefined || pgidText === '' || !Number.isInteger(pgid)) return undefined;
  const startedAt = Date.parse(rest.join(' '));
  return Number.isFinite(startedAt) ? { pgid, startedAt } : { pgid };
}

/**
 * `ps` is setuid root on macOS, and the kernel refuses to exec a setuid binary
 * from inside any sandbox — so under one, this answers nothing for every pid
 * and the reap ends nothing. The executor reaps at its own startup, unconfined.
 */
export function readProcessStart(pid: number): ProcessStart | undefined {
  try {
    return parseProcessStart(
      execFileSync('ps', ['-p', String(pid), '-o', 'pgid=,lstart='], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    // No such process, or `ps` is unavailable. Either way there is nothing
    // this may safely signal.
    return undefined;
  }
}

function stillTheRecordedProcess(record: OrphanRecord, processStart: ProcessStartSource): boolean {
  const live = processStart(record.pid);
  if (live?.pgid !== record.pid) return false;
  if (record.recordedAt === undefined || live.startedAt === undefined) return true;
  return Math.abs(live.startedAt - record.recordedAt) <= START_TIME_TOLERANCE_MS;
}

/** A live process's parent and command line, or nothing when `ps` cannot say. */
export function describeProcess(pid: number): { parentPid: number; command: string } | undefined {
  let line: string;
  try {
    line = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
  const match = /^(\d+)\s+(.*)$/.exec(line);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { parentPid: Number(match[1]), command: match[2] };
}

/**
 * End anything a previous executor left running and remove what it was using.
 * Called before this executor consumes its first job, so nothing from before is
 * still holding a credential while new work starts.
 */
export function reapOrphans(
  path: string,
  processStart: ProcessStartSource = readProcessStart,
): number {
  const records = readJournal(path);
  let ended = 0;
  for (const record of records) {
    try {
      if (stillTheRecordedProcess(record, processStart)) {
        // Negative pid: the group, so descendants go with it.
        process.kill(-record.pid, 'SIGKILL');
        ended += 1;
      }
    } catch {
      // Already gone, which is the common case and not a problem.
    }
    if (record.scratchDir === undefined) continue;
    try {
      rmSync(record.scratchDir, { recursive: true, force: true });
    } catch {
      // Best effort — a leftover directory is housekeeping, not authority.
    }
  }
  try {
    writeFileSync(path, '', { mode: 0o600 });
  } catch {
    // Nothing to do; the next reap will retry the same records harmlessly.
  }
  return ended;
}

/**
 * Forget one group that ended on its own, so the journal describes what is live
 * rather than everything this executor has ever run. Left to grow, it becomes a
 * list of pids the operating system has long since handed to somebody else.
 */
export function forgetSpawn(pid: number): void {
  if (journalPath === undefined) return;
  try {
    const kept = readJournal(journalPath).filter((record) => record.pid !== pid);
    writeFileSync(journalPath, kept.map((record) => `${JSON.stringify(record)}\n`).join(''), {
      mode: 0o600,
    });
  } catch {
    // The journal is a best-effort record; an entry that outlives its process
    // is checked for identity before anything is signalled.
  }
}

/**
 * Remove a directory now, on the way out. `rm` from the promises API schedules
 * work the event loop will never run inside an `exit` handler, so a clean
 * shutdown was leaving every session's checkout on disk.
 */
export function discardNow(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Housekeeping.
  }
}
