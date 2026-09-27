/**
 * Fetching the credential a harness already holds.
 *
 * This runs outside the boundary, as the operator, because that is the only
 * place the credential exists — a signed-in coding agent on macOS keeps its
 * token in the Keychain, and the one adapter option that would let a confined
 * process reach it also hands over the SSH agent and the Docker socket.
 *
 * Two things keep it narrow. The command is named in the machine's own policy
 * file, which the appliance cannot write and which already names the executable
 * that runs — so this is not a new class of authority. And the value never
 * leaves this module except into the harness's environment, with a scrubber
 * standing between it and anything the run reports.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  HarnessProfileError,
  readCredentialFromOutput,
  type HarnessProfile,
} from './harnessProfiles.js';

const run = promisify(execFile);

const CREDENTIAL_TIMEOUT_MS = 30_000;

export async function fetchCredential(profile: HarnessProfile): Promise<string | undefined> {
  const spec = profile.credential;
  if (!spec) return undefined;

  const [command, ...args] = spec.command;
  if (command === undefined) {
    throw new HarnessProfileError(
      `Harness '${profile.id}' has an empty credential command.`,
      'malformed_profile',
    );
  }
  let stdout: string;
  try {
    ({ stdout } = await run(command, args, { timeout: CREDENTIAL_TIMEOUT_MS }));
  } catch (error) {
    // Nothing from the failure is quoted back. Node builds the message from the
    // command line and the process's stderr, and a credential store that
    // complains on stderr would have its complaint — and whatever it quoted —
    // carried into a step result. The operator wrote the command; naming its
    // exit is enough to place the fault.
    const status =
      typeof (error as { code?: unknown }).code === 'number'
        ? `exit ${String((error as { code: number }).code)}`
        : 'did not complete';
    throw new HarnessProfileError(
      `The credential command for '${profile.id}' ${status}.`,
      'malformed_profile',
    );
  }
  return readCredentialFromOutput(profile, stdout);
}

/**
 * Remove a credential from text on its way out. The harness is the operator's
 * own and is trusted to do its job, not to keep a secret out of its logs; this
 * stands between whatever it prints and what the run reports.
 */
export function scrubSecret(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length < 8) return text;
  return text.split(secret).join('[redacted]');
}

/**
 * A scrubber for output that arrives in pieces.
 *
 * Scrubbing each chunk on its own does not work: a credential split across two
 * reads matches neither half, and live deltas are published as they arrive.
 * So the tail that could still become a match is held back until the next chunk
 * proves it cannot, and released at the end.
 */
export function createStreamScrubber(secret: string | undefined): {
  push: (chunk: string) => string;
  flush: () => string;
} {
  if (secret === undefined || secret.length < 8) {
    return { push: (chunk) => chunk, flush: () => '' };
  }
  const carryLength = secret.length - 1;
  let carry = '';
  return {
    push(chunk: string): string {
      const combined = carry + chunk;
      const scrubbed = combined.split(secret).join('[redacted]');
      // Hold back only what a later chunk could still complete. A tail that
      // already contains the secret has been replaced and is safe to release.
      const keep = Math.min(carryLength, scrubbed.length);
      carry = scrubbed.slice(scrubbed.length - keep);
      return scrubbed.slice(0, scrubbed.length - keep);
    },
    flush(): string {
      const remaining = carry.split(secret).join('[redacted]');
      carry = '';
      // Output can stop mid-credential — a cap truncating the stream, a process
      // killed. What is held back is then a proper prefix of the secret, and
      // releasing it verbatim publishes most of a token.
      for (let length = Math.min(remaining.length, secret.length - 1); length > 0; length -= 1) {
        if (remaining.endsWith(secret.slice(0, length))) {
          return `${remaining.slice(0, remaining.length - length)}[redacted]`;
        }
      }
      return remaining;
    },
  };
}
