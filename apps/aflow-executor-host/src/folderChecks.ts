/**
 * The checks a publication from a connected folder runs before anything leaves
 * the machine.
 *
 * Held in the machine's policy file beside the push posture and declared the
 * same way: by the operator, on this machine, and written only when chosen.
 * The argv is the operator's and never the workspace's — no operation takes a
 * command to run as a check — so nothing a run can say decides what clears its
 * own commit.
 */
import type { z } from 'zod';

import {
  type HostBindingBranchPolicy,
  HOST_CHECKS_TIMEOUT_DEFAULT_MS,
  HOST_CHECKS_TIMEOUT_MAX_MS,
  HOST_CHECKS_TIMEOUT_MIN_MS,
  HostChecksSchema,
  HostChecksTimeoutMsSchema,
} from '@aflow/schemas';

import type { HostBinding, HostPolicySchema } from './bindings.js';

type HostPolicy = z.infer<typeof HostPolicySchema>;

const MS_PER_MINUTE = 60_000;

/** What `harness checks` was asked to do. */
export type ChecksChange =
  | { readonly kind: 'set'; readonly argv: string[]; readonly timeoutMs?: number }
  | { readonly kind: 'timeout'; readonly timeoutMs: number }
  | { readonly kind: 'clear' };

function timeoutFromMinutes(raw: string | undefined): number {
  const minutes = raw === undefined ? Number.NaN : Number(raw);
  const parsed = HostChecksTimeoutMsSchema.safeParse(Math.round(minutes * MS_PER_MINUTE));
  if (!Number.isFinite(minutes) || !parsed.success) {
    throw new Error(
      `\`${raw ?? ''}\` is not a time the checks can be given: a number of minutes from ` +
        `${String(HOST_CHECKS_TIMEOUT_MIN_MS / MS_PER_MINUTE)} to ` +
        `${String(HOST_CHECKS_TIMEOUT_MAX_MS / MS_PER_MINUTE)}.`,
    );
  }
  return parsed.data;
}

/**
 * The arguments after `harness checks <folder>`, read as one change. Everything
 * after `--` is the argv, taken as it is: nothing here splits or quotes a
 * command line, so what the operator typed is what runs.
 */
export function checksChangeFromArgs(args: readonly string[]): ChecksChange {
  const separator = args.indexOf('--');
  const options = separator === -1 ? args : args.slice(0, separator);
  const argv = separator === -1 ? [] : args.slice(separator + 1);

  if (options.includes('--clear')) {
    if (options.length !== 1 || separator !== -1) {
      throw new Error('`--clear` drops the checks and their time, and takes nothing else.');
    }
    return { kind: 'clear' };
  }
  let timeoutMs: number | undefined;
  for (let i = 0; i < options.length; i += 1) {
    const option = options[i];
    if (option === '--timeout-minutes') {
      timeoutMs = timeoutFromMinutes(options[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(
      `\`${option ?? ''}\` is not an option of \`harness checks\`. The command to run goes ` +
        'after `--`.',
    );
  }
  if (separator === -1) {
    if (timeoutMs === undefined) {
      throw new Error('Name the command to run after `--`, or `--clear` to run none.');
    }
    return { kind: 'timeout', timeoutMs };
  }
  if (argv.length === 0) {
    throw new Error('Nothing follows `--`: name the program to run and its arguments.');
  }
  const parsed = HostChecksSchema.safeParse(argv);
  if (!parsed.success) {
    throw new Error(
      `That command cannot be saved as the checks: ${parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}.`,
    );
  }
  return { kind: 'set', argv: parsed.data, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}

function changed(
  branchPolicy: HostBindingBranchPolicy,
  change: ChecksChange,
  bindingId: string,
): HostBindingBranchPolicy {
  const { branchPrefix, pushApproval } = branchPolicy;
  const rest = { branchPrefix, ...(pushApproval !== undefined ? { pushApproval } : {}) };
  switch (change.kind) {
    case 'clear':
      return rest;
    case 'set': {
      const timeoutMs = change.timeoutMs ?? branchPolicy.checksTimeoutMs;
      return {
        ...rest,
        checks: change.argv,
        ...(timeoutMs !== undefined ? { checksTimeoutMs: timeoutMs } : {}),
      };
    }
    case 'timeout':
      if (branchPolicy.checks === undefined) {
        throw new Error(
          `\`${bindingId}\` declares no checks, so there is nothing to give time to. Name the ` +
            'command after `--`.',
        );
      }
      return { ...rest, checks: branchPolicy.checks, checksTimeoutMs: change.timeoutMs };
  }
}

/**
 * The policy with one folder's checks changed. Refused for a folder this
 * machine does not offer, and for one that pushes nothing: checks hold back a
 * publication, and that folder has none to hold back.
 */
export function withChecks(
  policy: HostPolicy,
  bindingId: string,
  change: ChecksChange,
): HostPolicy {
  const binding = policy.bindings.find((b) => b.id === bindingId);
  if (binding === undefined) {
    throw new Error(`This machine offers no folder \`${bindingId}\`.`);
  }
  if (binding.branchPolicy === undefined) {
    throw new Error(
      `\`${bindingId}\` pushes nothing, so no publication from it has checks to run. ` +
        'Reconnect it with `--branch-prefix <prefix>` to let it push.',
    );
  }
  const branchPolicy = changed(binding.branchPolicy, change, bindingId);
  return {
    ...policy,
    bindings: policy.bindings.map((b) => (b.id === bindingId ? { ...b, branchPolicy } : b)),
  };
}

/**
 * The checks a reconnected folder keeps: the ones it declared, as long as it
 * still pushes. A reconnect that drops the prefix drops them with it.
 */
export function keptChecks(
  current: HostBindingBranchPolicy | undefined,
  branchPrefix: string | undefined,
): Pick<HostBindingBranchPolicy, 'checks' | 'checksTimeoutMs'> {
  if (branchPrefix === undefined || current?.checks === undefined) return {};
  return {
    checks: current.checks,
    ...(current.checksTimeoutMs !== undefined ? { checksTimeoutMs: current.checksTimeoutMs } : {}),
  };
}

/** The checks a folder runs and the time they get; no argv where it declares none. */
export function checksOf(binding: HostBinding): {
  readonly argv?: readonly string[];
  readonly timeoutMs: number;
} {
  const policy = binding.branchPolicy;
  return {
    ...(policy?.checks !== undefined ? { argv: policy.checks } : {}),
    timeoutMs: policy?.checksTimeoutMs ?? HOST_CHECKS_TIMEOUT_DEFAULT_MS,
  };
}

export function formatMinutes(ms: number): string {
  const minutes = ms / MS_PER_MINUTE;
  return `${Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1)} min`;
}

/** One line for the folder's checks, in the words the CLI prints. */
export function describeChecks(branchPolicy: HostBindingBranchPolicy): string {
  if (branchPolicy.checks === undefined) {
    return 'runs no checks before a push';
  }
  const timeoutMs = branchPolicy.checksTimeoutMs ?? HOST_CHECKS_TIMEOUT_DEFAULT_MS;
  return (
    `runs \`${branchPolicy.checks.join(' ')}\` before a push, for up to ` +
    `${formatMinutes(timeoutMs)}${branchPolicy.checksTimeoutMs === undefined ? ', the default' : ''}`
  );
}
