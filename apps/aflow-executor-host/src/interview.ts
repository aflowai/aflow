/**
 * Asking the operator, on the machine where the answer lives.
 *
 * A web page cannot see a filesystem or a `PATH`, so everything it needs from
 * the operator it has to ask for as text — which is how connecting a folder came
 * to mean substituting a placeholder into a shell command and knowing which
 * flags to append. This runs where those answers are already available: the
 * folder is the one the operator is standing in, and the tools are the ones on
 * their `PATH`. What is left is confirmation, which is a keypress.
 *
 * It is also where consent belongs. The appliance cannot grant itself a folder;
 * the operator says yes here, on their own machine, which is the property the
 * two halves exist to keep.
 */
import { createInterface } from 'node:readline/promises';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';

import { HostBranchPrefixSchema } from '@aflow/schemas';

import { toolchainReadPaths } from './sandboxPolicy.js';
import { join } from 'node:path';

export interface Prompter {
  /** Whether there is anyone to answer. A caller may need to refuse rather than assume. */
  readonly interactive: boolean;
  ask(question: string, fallback: string): Promise<string>;
  /**
   * For a question with no sensible answer to suggest. A default reads as a
   * recommendation, so offering one that is never right is worse than offering
   * none — `yarn workspace` runs a script from the package's own directory, and
   * the folder prompt was suggesting this executor's source tree.
   */
  askRequired(question: string): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  say(line: string): void;
  close(): void;
}

/**
 * Defaults are taken without asking when there is no terminal to ask. A command
 * in a script should behave, not block forever on a prompt nobody will see.
 */
export function createPrompter(): Prompter {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const rl = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;

  return {
    interactive,
    async ask(question: string, fallback: string): Promise<string> {
      if (rl === undefined) return fallback;
      const answer = (await rl.question(`${question} [${fallback}] `)).trim();
      return answer === '' ? fallback : answer;
    },
    async askRequired(question: string): Promise<string> {
      if (rl === undefined) throw new Error(`${question} — and there is no terminal to ask.`);
      for (;;) {
        const answer = (await rl.question(`${question} `)).trim();
        if (answer !== '') return answer;
      }
    },
    async confirm(question: string, fallback: boolean): Promise<boolean> {
      if (rl === undefined) return fallback;
      const hint = fallback ? 'Y/n' : 'y/N';
      const answer = (await rl.question(`${question} [${hint}] `)).trim().toLowerCase();
      if (answer === '') return fallback;
      return answer.startsWith('y');
    },
    say(line: string): void {
      process.stdout.write(`${line}\n`);
    },
    close(): void {
      rl?.close();
    },
  };
}

export interface BranchPrefixQuestion {
  /** What `--branch-prefix` said, when the operator said it on the command line. */
  readonly requested?: string | undefined;
  readonly allowsExecution: boolean;
  /** Whether the folder has a history to publish. A prefix governs nothing without one. */
  readonly repository: boolean;
  readonly root: string;
}

/**
 * Pushes land under a namespace of their own, so nothing published from a folder
 * reaches `main` or anyone else's branch without a pull request — a default
 * that can only make branches nobody else uses needs no question.
 */
export const DEFAULT_BRANCH_PREFIX = 'aflow/';

/**
 * Which branches this folder may be pushed to, decided here rather than in the
 * workspace: it is the operator's machine that holds the repository.
 *
 * A push is a command, so a prefix without the execution grant is a
 * contradiction rather than a narrower grant, and is refused instead of being
 * quietly widened or quietly dropped.
 *
 * A folder with no history is in the same position: there is nothing a prefix
 * could govern, so none is recorded and an explicit one is refused rather than
 * kept against a folder that could never push.
 */
export function resolveBranchPrefix(question: BranchPrefixQuestion): string | undefined {
  if (question.requested !== undefined && !question.allowsExecution) {
    throw new Error(
      'A push is a command, so a branch prefix needs a folder that allows them: add `--run`.',
    );
  }
  if (question.requested !== undefined && !question.repository) {
    throw new Error(
      `A branch prefix is a rule about pushes, and \`${question.root}\` is not a git repository.`,
    );
  }
  const answer =
    question.requested ??
    (question.allowsExecution && question.repository ? DEFAULT_BRANCH_PREFIX : '');
  if (answer === '') return undefined;
  const parsed = HostBranchPrefixSchema.safeParse(answer);
  if (!parsed.success) {
    throw new Error(
      `\`${answer}\` is not a branch prefix: ${parsed.error.issues.map((i) => i.message).join(' ')}`,
    );
  }
  return parsed.data;
}

export interface FoundTool {
  /** One tool in it, so the operator recognises the folder by what it holds. */
  readonly name: string;
  readonly directory: string;
  /** How many runnable things it holds, `name` included. */
  readonly count: number;
}

/**
 * A package manager puts a project's own `node_modules/.bin` on `PATH` for the
 * one command it runs, so the folder shows up here only because this connect
 * was launched through it. It belongs to a project, not the machine: a run in a
 * connected folder already reaches that folder's own tools.
 */
const PROJECT_LOCAL_TOOL_DIR = '/node_modules/.bin';

/**
 * The directories on `PATH` that hold something runnable, with an example.
 *
 * Home is denied as a region, so a CLI installed under it is unreachable until
 * the operator says otherwise — and the remedy used to be editing a JSON file
 * they had never opened, to add a key they had not heard of. Offering the
 * directories their own tools already live in turns that into a yes.
 *
 * Directories rather than individual programs: a tool that shells out to its own
 * helpers needs its neighbours, and a per-binary allowance fails on the second
 * call for reasons nobody can see.
 */
export async function toolDirectoriesOnPath(
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly within?: string } = {},
): Promise<FoundTool[]> {
  const home = homedir();
  const alreadyReachable = toolchainReadPaths(home);
  const seen = new Map<string, { name: string; count: number }>();
  for (const entry of (env['PATH'] ?? '').split(':')) {
    const dir = entry.trim();
    if (dir === '' || seen.has(dir)) continue;
    // Only what home denies. Everything else is already reachable, and offering
    // it would be a question with no consequence either way.
    if (!dir.startsWith(`${home}/`)) continue;
    if (dir.endsWith(PROJECT_LOCAL_TOOL_DIR)) continue;
    // The folder being connected reaches its own contents; offering a tool
    // folder inside it is the same question with no consequence.
    if (
      options.within !== undefined &&
      (dir === options.within || dir.startsWith(`${options.within}/`))
    )
      continue;
    // Including the toolchains the sandbox already carves out. Three `.nvm`
    // directories arrived at the top of this list on first use — questions whose
    // answer changed nothing, burying the one entry that was the reason to ask.
    // Read from the policy rather than restated here, so the two cannot drift.
    if (alreadyReachable.some((root) => dir === root || dir.startsWith(`${root}/`))) continue;
    const tools = await executablesIn(dir);
    const first = tools[0];
    if (first !== undefined) seen.set(dir, { name: first, count: tools.length });
  }
  return [...seen].map(([directory, { name, count }]) => ({ directory, name, count }));
}

async function executablesIn(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    const { readdir } = await import('node:fs/promises');
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries.sort()) {
    try {
      const full = join(dir, entry);
      const info = await stat(full);
      if (!info.isFile()) continue;
      await access(full, constants.X_OK);
      found.push(entry);
    } catch {
      continue;
    }
  }
  return found;
}
