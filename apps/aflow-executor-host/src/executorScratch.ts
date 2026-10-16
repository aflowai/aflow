/**
 * The scratch directories this executor makes under the temp root.
 *
 * Each is marked when it is made, so the boot sweep (`removeOrphanedCheckouts`)
 * knows a directory is the executor's by what the directory says of itself —
 * its name and its marker — and never by the shape of what a run left in it: a
 * run killed part-way leaves a clone in any shape at all.
 */
import { lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The file that marks a directory under the temp root as this executor's scratch. */
export const SCRATCH_MARKER = '.aflow-scratch';

/** The directory of a scratch that a sandboxed job is handed as its own. */
export const AGENT_SCRATCH_DIR = 'agent';

/**
 * Where in `scratch` a sandboxed job may write, made if it is not there yet.
 *
 * Never the scratch itself: that holds the job's checkout and its git
 * directory, which the executor's own git later stages, merges and fetches
 * from outside the sandbox. A job able to write the scratch could remove the
 * checkout and put a link in its place, so the sandbox is granted the checkout
 * and this directory, and nothing that holds the checkout.
 */
export async function makeAgentScratch(scratch: string): Promise<string> {
  const dir = join(scratch, AGENT_SCRATCH_DIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** A new scratch directory named `<prefix>…` under `root`, marked as this executor's. */
export async function makeScratch(prefix: string, root: string = tmpdir()): Promise<string> {
  const scratch = await mkdtemp(join(root, prefix));
  await writeFile(join(scratch, SCRATCH_MARKER), '', 'utf8');
  return scratch;
}

/** Whether `scratch` carries the marker `makeScratch` leaves. */
export async function isMarkedScratch(scratch: string): Promise<boolean> {
  return (await lstat(join(scratch, SCRATCH_MARKER)).catch(() => undefined))?.isFile() === true;
}
