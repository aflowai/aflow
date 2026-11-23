/**
 * How a harness run's structured inputs reach the harness. The task is one
 * argument of the harness's argv, so inputs that grow with a workflow's
 * history would otherwise grow it past what the machine lets a process start
 * with. Inputs past a cap go to a file in the run's scratch directory, which
 * no diff of the checkout carries, and the task names the file.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { RUN_SCRATCH_DIR } from './worktree.js';

export const INLINE_INPUTS_MAX_BYTES = 16_000;
export const INPUTS_RELATIVE_PATH = `${RUN_SCRATCH_DIR}/inputs.json`;

/** The inputs as JSON where they are too large to travel in the task, else undefined. */
export function inputsFileContent(inputs: Record<string, unknown> | undefined): string | undefined {
  if (inputs === undefined || Object.keys(inputs).length === 0) return undefined;
  const json = JSON.stringify(inputs);
  return Buffer.byteLength(json, 'utf8') > INLINE_INPUTS_MAX_BYTES ? json : undefined;
}

/**
 * Removes the inputs file from the checkout. A session's checkout outlives
 * its turn, and an earlier turn's inputs beside the work read like this one's.
 */
export async function removeInputsFile(workDir: string): Promise<void> {
  await rm(join(workDir, INPUTS_RELATIVE_PATH), { force: true });
}

/**
 * Writes inputs past the cap into the checkout, and returns the path the task
 * names, else undefined. Inputs small enough to travel in the task remove any
 * file an earlier turn left.
 */
export async function writeInputsFile(
  workDir: string,
  inputs: Record<string, unknown> | undefined,
): Promise<string | undefined> {
  const json = inputsFileContent(inputs);
  if (json === undefined) {
    await removeInputsFile(workDir);
    return undefined;
  }
  const path = join(workDir, INPUTS_RELATIVE_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, json, 'utf8');
  return INPUTS_RELATIVE_PATH;
}

/** The task with its structured inputs attached, or the file that holds them, so the prose can name them. */
export function taskWithInputs(
  task: string,
  inputs: Record<string, unknown> | undefined,
  inputsFile?: string,
): string {
  if (inputs === undefined || Object.keys(inputs).length === 0) return task;
  if (inputsFile !== undefined) {
    return (
      `${task}\n\nThe inputs for this task are in \`${inputsFile}\`, relative to the root of ` +
      'this checkout, as one JSON object. Read the whole file before you start.'
    );
  }
  return `${task}\n\nInputs for this task, as JSON:\n${JSON.stringify(inputs)}`;
}
