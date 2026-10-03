/**
 * A coding agent and a folder's checks run under the folder's sandbox posture;
 * every other command runs confined whatever the folder says, because it is a
 * command an agent wrote rather than the operator's own tool.
 */
import type { HostBinding } from './bindings.js';
import { sandboxPostureOf } from './sandboxPosture.js';
import {
  runOpen,
  runSandboxed,
  sandboxReadiness,
  type SandboxedRunInput,
  type SandboxedRunResult,
} from './sandboxedRun.js';

/** An `open` folder needs no qualified sandbox on the machine; a `confined` one does. */
export function folderRunReadiness(binding: Pick<HostBinding, 'sandbox'>): {
  ready: boolean;
  missing: string[];
} {
  return sandboxPostureOf(binding) === 'open' ? { ready: true, missing: [] } : sandboxReadiness();
}

export async function runUnderFolderPosture(input: SandboxedRunInput): Promise<SandboxedRunResult> {
  return sandboxPostureOf(input.binding) === 'open'
    ? await runOpen(input)
    : await runSandboxed(input);
}
