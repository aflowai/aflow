/**
 * Noticing a withdrawal without being asked.
 *
 * Every operation reconciles what is running against the current policy, which
 * covers the case where work keeps arriving. It does not cover the case the
 * lane was built for: a detached command or a coding session runs precisely so
 * the step can end, so ordinarily nothing arrives afterwards — and an operator
 * who withdraws a binding then waits for a timeout that may be hours away.
 *
 * A watch on the file is the event the operator already generates by editing
 * it. No polling, no interval, and an idle cost that does not grow with
 * bindings, machines or anything else: one descriptor, whether the file changes
 * once a day or never.
 */
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

export interface PolicyWatch {
  close: () => void;
  /** False when no watch could be set up on the directory, or the one there was failed. */
  watching: () => boolean;
}

export interface PolicyFollowers {
  /** Ends host processes and sessions under a binding the policy no longer grants. */
  readonly reapHostWork: () => Promise<void>;
  /** Brings running browsers and their pages in line with the policy. */
  readonly followInBrowsers: () => Promise<void>;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}

/**
 * Act on a policy that changed. Withdrawn host work is ended first and owes
 * nothing to the browser: a page slow to close, or a browser that fails to
 * follow, must not keep a withdrawn process alive.
 */
export async function followPolicy(followers: PolicyFollowers): Promise<void> {
  await followers.reapHostWork();
  try {
    await followers.followInBrowsers();
  } catch (error) {
    followers.warn('Running browsers could not follow the changed host policy', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Other files in the policy's directory the same watch looks out for. */
export interface DirectoryFollower {
  matches(filename: string): boolean;
  onChange(): void;
}

/**
 * Call `onChange` when the policy file changes, coalescing the burst an editor
 * produces — a rename-and-replace can fire several events for one save, and
 * reconciling four times is wasted work, not four withdrawals. A `follower`
 * is told of its own files at once, through the same descriptor.
 */
export function watchPolicy(
  policyPath: string,
  onChange: () => void,
  settleMs = 250,
  follower?: DirectoryFollower,
): PolicyWatch {
  let pending: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;

  const fire = (): void => {
    if (pending !== undefined) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      onChange();
    }, settleMs);
  };

  // The directory, not the file.
  //
  // Watching the file follows its inode, and an atomic save — write a
  // temporary, rename over the target — leaves the watch pointed at an inode
  // nothing will touch again. Every editor does this, and so does the writer
  // in this repository, so the first real save killed the watch and every
  // withdrawal after it went unnoticed. A directory watch survives the rename
  // because the directory is what changed.
  const target = basename(policyPath);
  try {
    watcher = watch(dirname(policyPath), { persistent: false }, (_event, filename) => {
      // `filename` can be null on some platforms; a change in a directory that
      // holds one file we care about is worth reconciling either way.
      if (filename === null || basename(filename) === target) fire();
      if (follower !== undefined && (filename === null || follower.matches(basename(filename)))) {
        follower.onChange();
      }
    });
    watcher.on('error', () => {
      watcher?.close();
      watcher = undefined;
    });
  } catch {
    // No watch available on this filesystem. The per-operation reconciliation
    // remains, which is what this supplements rather than replaces, and the
    // browser requests are polled for instead (`watching`).
  }

  return {
    close: (): void => {
      if (pending !== undefined) clearTimeout(pending);
      watcher?.close();
      watcher = undefined;
    },
    watching: (): boolean => watcher !== undefined,
  };
}
