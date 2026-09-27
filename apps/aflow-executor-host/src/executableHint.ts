/**
 * Explaining a command that could not start.
 *
 * Home is denied as a region, which is what protects keys and credentials — and
 * which also catches every tool installed under it. The shell reports that as
 * `Operation not permitted` or `command not found`, both of which read like a
 * broken install rather than a boundary refusing a read, so the operator goes
 * looking in the wrong place.
 *
 * The boundary knows better, so it says so. This is the same move the sandbox's
 * blocked-host reporting makes: a refusal nobody can attribute is a refusal
 * nobody can act on.
 */
import { isAbsolute } from 'node:path';

/** Exit codes a shell uses for "could not execute" and "not found". */
const CANNOT_EXECUTE = 126;
const NOT_FOUND = 127;

function withinHome(path: string, home: string): boolean {
  return path === home || path.startsWith(`${home}/`);
}

/**
 * A sentence to append when the reason is likely the read boundary, and
 * nothing when it is not — a wrong flag should not be answered with advice
 * about installation paths.
 */
export function explainFailedStart(
  argv: readonly string[],
  exitCode: number | null,
  output: string,
  home: string,
  toolPaths: readonly string[],
): string | undefined {
  if (exitCode !== CANNOT_EXECUTE && exitCode !== NOT_FOUND) return undefined;
  if (!/not permitted|not found|No such file|cannot execute/i.test(output)) return undefined;

  const program = argv[0];
  if (program === undefined) return undefined;

  // Only an absolute path can be judged from here. A bare name is resolved
  // against PATH inside the sandbox, and guessing which entry it would have
  // found would be inventing the cause rather than reporting it.
  if (!isAbsolute(program)) {
    return (
      `\`${program}\` could not be started. If it is installed under your home directory, ` +
      'the boundary denies that region and the command cannot be read — add where it lives ' +
      "to `toolPaths` in this machine's host policy, or give an absolute path so this can " +
      'say for certain.'
    );
  }

  if (!withinHome(program, home)) return undefined;
  if (toolPaths.some((allowed) => withinHome(program, allowed) || program === allowed)) {
    return undefined;
  }

  return (
    `\`${program}\` is under your home directory, which the boundary denies as a region — ` +
    'so the command could not be read, whatever its permissions say. Add the directory it ' +
    "lives in to `toolPaths` in this machine's host policy."
  );
}
