/**
 * Which environment variables a job may set.
 *
 * The workload runs inside the sandbox, but the process that *installs* the
 * sandbox is an ordinary Node process started a moment earlier, and Node reads
 * `NODE_OPTIONS` at boot. A job supplying `NODE_OPTIONS=--require /path/x.js`
 * therefore executes that file as the operator, unconfined, before any boundary
 * exists — the command it asked to run never has to do anything.
 *
 * The same shape holds for the dynamic loader (`LD_PRELOAD`, `DYLD_*`) and for
 * the variables the sandbox's own proxy reads to decide where egress goes.
 * These are refused by name rather than stripped, because a job that set one
 * expected it to take effect and silently dropping it hides the refusal.
 *
 * Everything else passes. The point of this lane is the operator's own
 * toolchain, and a workload that cannot be given an API key or a build flag is
 * not worth confining.
 */

/** Prefixes owned by a runtime or loader that acts before the workload does. */
const DENIED_PREFIXES = ['NODE_', 'DYLD_', 'LD_'] as const;

/**
 * Names that steer the host process, its egress, or its trust roots. `PATH` is
 * here because it selects which binary the sandbox launcher itself resolves.
 */
const DENIED_NAMES = new Set([
  'PATH',
  'TMPDIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'OPENSSL_CONF',
  'SRT_DEBUG',
]);

/**
 * A variable name as the operating system will read it back.
 *
 * The environment is a list of `NAME=VALUE` strings split on the *first* `=`,
 * so a key that itself contains one is not the name it appears to be: the entry
 * `{'HTTPS_PROXY=http://elsewhere/': 'x'}` reaches the child as the variable
 * `HTTPS_PROXY`, and a deny list comparing whole keys never sees it. Requiring
 * the POSIX shape closes that and every neighbouring trick — whitespace,
 * embedded NUL, a name that is only a lookalike — in one rule, instead of a
 * list that has to anticipate each.
 */
const NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class EnvPolicyError extends Error {
  constructor(
    readonly names: string[],
    reason: 'denied' | 'malformed' = 'denied',
  ) {
    super(
      reason === 'malformed'
        ? `These environment variable names are not names the operating system will read back as written: ${names.join(', ')}. ` +
            'Use letters, digits and underscores, starting with a letter or underscore.'
        : `These environment variables steer the sandbox launcher rather than the command, so they cannot be set by a job: ${names.join(', ')}. ` +
            'Set what the command itself reads instead.',
    );
    this.name = 'EnvPolicyError';
  }
}

/** Case-insensitive: the host may or may not fold names, and the risk does not. */
function isDenied(name: string): boolean {
  const upper = name.toUpperCase();
  return DENIED_NAMES.has(upper) || DENIED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export function assertSafeEnv(env: Record<string, string>): void {
  const names = Object.keys(env);

  // Shape first: a malformed name is not yet the variable it will become, so
  // asking whether it is denied would ask about the wrong string.
  const malformed = names.filter((name) => !NAME_SHAPE.test(name)).sort();
  if (malformed.length > 0) throw new EnvPolicyError(malformed, 'malformed');

  const denied = names.filter(isDenied).sort();
  if (denied.length > 0) throw new EnvPolicyError(denied);
}
