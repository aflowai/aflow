/**
 * What this machine actually has, observed rather than declared.
 *
 * An operator asking a workspace to run their tests wants to know the machine
 * can; a declared list would drift from the truth the first time something was
 * installed or removed. So the executor asks the machine at startup, and the
 * answer expires — a stale inventory is worse than none, because it invites a
 * run that fails on a tool that is no longer there.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Enough to find and run a version command, and nothing this executor holds. */
function probeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Probed by asking for a version, which is the one flag they agree on. */
const PROBES: ReadonlyArray<{ name: string; command: string; args: string[] }> = [
  { name: 'node', command: 'node', args: ['--version'] },
  { name: 'python3', command: 'python3', args: ['--version'] },
  { name: 'git', command: 'git', args: ['--version'] },
  { name: 'docker', command: 'docker', args: ['--version'] },
  { name: 'go', command: 'go', args: ['version'] },
  { name: 'cargo', command: 'cargo', args: ['--version'] },
  { name: 'java', command: 'java', args: ['-version'] },
  { name: 'make', command: 'make', args: ['--version'] },
];

export interface HostRuntime {
  name: string;
  version: string;
}

/** First line, trimmed: every one of these prints its version there. */
function firstLine(output: string): string {
  return output.split('\n')[0]?.trim() ?? '';
}

export async function observeRuntimes(): Promise<HostRuntime[]> {
  const found = await Promise.all(
    PROBES.map(async ({ name, command, args }) => {
      try {
        // `java -version` writes to stderr, which is its own convention rather
        // than an error, so both streams are considered.
        // The same minimal environment the git path uses. A probe runs an
        // operator-controlled program found on `PATH`, so handing it this
        // executor's Redis credential to ask for a version number is a trade
        // with nothing on the other side of it.
        const { stdout, stderr } = await run(command, args, {
          timeout: 3_000,
          env: probeEnv(),
        });
        const version = firstLine(stdout) || firstLine(stderr);
        return version === '' ? null : { name, version };
      } catch {
        // Absent, or not on PATH, which for this purpose is the same thing.
        return null;
      }
    }),
  );
  return found.filter((r): r is HostRuntime => r !== null);
}
