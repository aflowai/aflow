/**
 * What a coding agent and a folder's checks run under: the folder's sandbox
 * posture.
 *
 * A posture on the folder, held in the machine's policy file beside its push
 * posture and its checks, and changed only from this machine. The file holds
 * only a posture the operator chose; a folder that chose none takes
 * `HOST_SANDBOX_POSTURE_DEFAULT` when the file is read, where the reason for
 * that default is written.
 */
import type { z } from 'zod';

import {
  HOST_SANDBOX_POSTURE_DEFAULT,
  type HostSandboxPosture,
  HostSandboxPostureSchema,
} from '@aflow/schemas';

import type { HostBinding, HostPolicySchema } from './bindings.js';

type HostPolicy = z.infer<typeof HostPolicySchema>;

export const SANDBOX_POSTURE_VALUES: readonly HostSandboxPosture[] =
  HostSandboxPostureSchema.options;

/** The posture a run in this folder spawns under. */
export function sandboxPostureOf(binding: Pick<HostBinding, 'sandbox'>): HostSandboxPosture {
  return binding.sandbox ?? HOST_SANDBOX_POSTURE_DEFAULT;
}

/** One line per posture, in the words the CLI prints. */
export function describeSandboxPosture(posture: HostSandboxPosture): string {
  switch (posture) {
    case 'open':
      return (
        "runs its coding agents and checks inside this machine's sandbox with the network " +
        'open: every host and its local servers'
      );
    case 'confined':
      return (
        "runs its coding agents and checks inside this machine's sandbox, reaching only the " +
        'hosts a coding agent is allowed and none of its local servers'
      );
  }
}

/** The line `harness list` and `connect` print for a folder that runs commands. */
export function describeFolderSandbox(binding: Pick<HostBinding, 'sandbox'>): string {
  return (
    describeSandboxPosture(sandboxPostureOf(binding)) +
    (binding.sandbox === undefined ? ', the default' : '')
  );
}

function parseSandboxPosture(value: string): HostSandboxPosture {
  const parsed = HostSandboxPostureSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `\`${value}\` is not a sandbox posture. It is one of: ${SANDBOX_POSTURE_VALUES.join(', ')}.`,
    );
  }
  return parsed.data;
}

/**
 * The posture a reconnected folder keeps: the one it chose, as long as it still
 * runs commands. A folder that runs none has nothing to run under.
 */
export function keptSandboxPosture(
  current: Pick<HostBinding, 'sandbox'> | undefined,
  allowsExecution: boolean,
): Pick<HostBinding, 'sandbox'> {
  return allowsExecution && current?.sandbox !== undefined ? { sandbox: current.sandbox } : {};
}

/**
 * The policy with one folder's posture changed. Refused for a folder this
 * machine does not offer, and for one that runs no commands.
 */
export function withSandboxPosture(
  policy: HostPolicy,
  bindingId: string,
  requested: string,
): HostPolicy {
  const sandbox = parseSandboxPosture(requested);
  const binding = policy.bindings.find((b) => b.id === bindingId);
  if (binding === undefined) {
    throw new Error(`This machine offers no folder \`${bindingId}\`.`);
  }
  if (!binding.allowsExecution) {
    throw new Error(
      `\`${bindingId}\` runs no commands, so nothing runs there to be confined or not. ` +
        'Reconnect it with `--run` to let a coding agent work in it.',
    );
  }
  return {
    ...policy,
    bindings: policy.bindings.map((b) => (b.id === bindingId ? { ...b, sandbox } : b)),
  };
}

/** `harness sandbox <folder> open|confined`: the policy it leaves, and the line it prints. */
export function sandboxVerb(
  policy: HostPolicy,
  bindingId: string,
  args: readonly string[],
): { readonly policy: HostPolicy; readonly said: string } {
  const [requested, ...extra] = args;
  if (requested === undefined || requested === '' || extra.length > 0) {
    throw new Error(
      `Name one posture for \`${bindingId}\`: ${SANDBOX_POSTURE_VALUES.join(' or ')}.`,
    );
  }
  const updated = withSandboxPosture(policy, bindingId, requested);
  const posture = parseSandboxPosture(requested);
  return {
    policy: updated,
    said: `\`${bindingId}\` now ${describeSandboxPosture(posture)}.`,
  };
}
