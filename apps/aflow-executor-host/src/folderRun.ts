/**
 * A coding agent and a folder's checks run under the folder's sandbox posture;
 * every other command runs `confined` whatever the folder says, because it is a
 * command an agent wrote rather than the operator's own tool. Both postures are
 * the sandbox, and they differ in the network alone.
 */
import { sandboxPostureOf } from './sandboxPosture.js';
import { runSandboxed, type SandboxedRunInput, type SandboxedRunResult } from './sandboxedRun.js';

export async function runUnderFolderPosture(input: SandboxedRunInput): Promise<SandboxedRunResult> {
  return await runSandboxed({ ...input, posture: sandboxPostureOf(input.binding) });
}
