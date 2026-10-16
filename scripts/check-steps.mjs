/**
 * One step of the check, as its live output shows it: a line naming what it
 * is doing as it starts — `building @aflow/schemas` — so a check minutes into
 * its builds reads as that rather than as a run, and a line when it ends,
 * `ok` or `FAIL` with its time.
 *
 * The step runs while this process waits on it rather than blocking: standard
 * output to a pipe is written asynchronously on macOS, so a line printed
 * before a blocking spawn reaches the reader only once the step is over.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

/** What one step may print before the rest is let go: a type-check of a broken workspace fits. */
export const STEP_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

export function elapsed(startedAt) {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)} s`;
}

function writeLine(text) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * Run `command` as the step `label`, saying `activity` as it starts. Resolves
 * with whether it exited 0 and what it printed, both streams in the order they
 * came; the `ok` line is printed here, a failure left to the caller, which
 * may have more to say before it ends the run.
 */
export async function runStep({ label, activity, command, args, cwd, env }) {
  const startedAt = Date.now();
  writeLine(activity);
  const chunks = [];
  let kept = 0;
  let dropped = 0;
  const keep = (chunk) => {
    if (kept + chunk.length > STEP_OUTPUT_LIMIT_BYTES) {
      dropped += chunk.length;
      return;
    }
    chunks.push(chunk);
    kept += chunk.length;
  };
  const ended = await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.once('error', (error) => {
      resolve({ error });
    });
    child.once('close', (code, signal) => {
      resolve({ code, signal });
    });
  });
  let printed = Buffer.concat(chunks).toString('utf8');
  if (dropped > 0) printed += `[${String(dropped)} more bytes printed were not kept]\n`;
  if (ended.error !== undefined) printed += `${ended.error.message}\n`;
  else if (ended.code === null) printed += `ended by ${String(ended.signal)}\n`;
  const passed = ended.error === undefined && ended.code === 0;
  if (passed) writeLine(`ok   ${label} (${elapsed(startedAt)})`);
  return { passed, printed, startedAt };
}

/**
 * End the run on a failed step, with what it printed — once that has reached
 * the reader, since an exit drops what a pipe has not yet taken.
 */
export async function failStep(label, startedAt, printed) {
  writeLine(`FAIL ${label} (${elapsed(startedAt)})`);
  if (printed.trim() !== '') writeLine(printed);
  await new Promise((resolve) => process.stdout.write('', resolve));
  process.exit(1);
}
