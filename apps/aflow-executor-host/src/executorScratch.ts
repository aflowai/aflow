/**
 * The scratch directories this executor makes under the temp root.
 *
 * Each is marked when it is made, so the boot sweep (`removeOrphanedCheckouts`)
 * knows a directory is the executor's by what the directory says of itself —
 * its name and its marker — and never by the shape of what a run left in it: a
 * run killed part-way leaves a clone in any shape at all.
 */
import { lstat, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The file that marks a directory under the temp root as this executor's scratch. */
export const SCRATCH_MARKER = '.aflow-scratch';

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
