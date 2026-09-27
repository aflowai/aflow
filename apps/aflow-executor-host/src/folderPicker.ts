/**
 * The operating system's own folder chooser.
 *
 * A browser cannot supply a path, and this is not a restriction to work around:
 * `webkitdirectory` yields relative names, `showDirectoryPicker` yields a handle
 * scoped to the page's origin, and neither will disclose an absolute path to
 * anything. Upload works because the page is allowed to have the *bytes*; a
 * binding needs the *path*, and the executor that will open it is a separate
 * process on the machine.
 *
 * So the picker runs where paths are allowed to exist. The operator gets the
 * dialog they already know instead of pasting a path into a prompt, and the
 * answer comes from them rather than from anything the appliance said.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** What the operator did with the dialog, kept distinct because they differ. */
export type FolderChoice =
  | { readonly kind: 'chosen'; readonly path: string }
  /** Dismissed. A deliberate no, so nothing should be offered in its place. */
  | { readonly kind: 'cancelled' }
  /** No dialog to show — another platform, or no session that can display one. */
  | { readonly kind: 'unavailable' };

/** Injectable so the branching is testable without a dialog opening on someone's screen. */
export type PickerRunner = (script: string) => Promise<string>;

const appleScript = (prompt: string): string =>
  // `POSIX path of` because `choose folder` answers with an alias, which is a
  // Finder reference rather than anything a process can open.
  `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`;

async function runOsascript(script: string): Promise<string> {
  const { stdout } = await run('osascript', ['-e', script], { timeout: 10 * 60 * 1000 });
  return stdout;
}

/**
 * Cancelling is `-128`, which arrives as a non-zero exit like any other failure.
 * Reading it as "the picker is broken" would fall through to the next question
 * and ask the operator for the thing they just declined to give.
 */
function looksCancelled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('-128') || /user cancel?led/i.test(message);
}

export async function chooseFolder(
  prompt: string,
  options: { readonly platform?: string; readonly runner?: PickerRunner } = {},
): Promise<FolderChoice> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return { kind: 'unavailable' };

  const runner = options.runner ?? runOsascript;
  let stdout: string;
  try {
    stdout = await runner(appleScript(prompt));
  } catch (error) {
    if (looksCancelled(error)) return { kind: 'cancelled' };
    // A machine with no window session — ssh, a launch agent — cannot show a
    // dialog, and that is a reason to ask in text rather than to fail.
    return { kind: 'unavailable' };
  }

  // `POSIX path of` ends a directory with a separator; every path comparison
  // downstream is written against the unslashed form.
  const chosen = stdout.trim().replace(/\/+$/, '');
  return chosen === '' ? { kind: 'unavailable' } : { kind: 'chosen', path: chosen };
}
