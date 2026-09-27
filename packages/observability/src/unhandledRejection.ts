/**
 * A long-running service must not die of a stray promise rejection.
 *
 * Node's default for an unhandled rejection is to throw, which terminates the
 * process. Sentry's SDK happens to prevent that — its `OnUnhandledRejection`
 * integration attaches a listener, and any listener suppresses the default —
 * but only once `Sentry.init` has run, and that is conditional on a DSN
 * reaching the container. So the fleet's crash behaviour is decided by an
 * observability credential: hosts that receive the DSN log and continue, hosts
 * that miss it exit on the same rejection. A missing DSN should cost
 * visibility, not availability.
 *
 * Installed before the DSN is even read, and idempotent, so it holds on every
 * host and defers to Sentry's richer reporting wherever that is also active.
 */

let installed = false;

export interface RejectionGuardHooks {
  /** Reports the rejection where the process's telemetry can see it. */
  report?: (reason: unknown) => void;
  /** Present only so tests can observe without a real process listener. */
  onProcess?: (event: 'unhandledRejection', handler: (reason: unknown) => void) => void;
}

export function installUnhandledRejectionGuard(
  serviceName: string,
  hooks: RejectionGuardHooks = {},
): boolean {
  if (installed) return false;
  installed = true;

  const attach = hooks.onProcess ?? ((event, handler) => process.on(event, handler));
  attach('unhandledRejection', (reason: unknown) => {
    hooks.report?.(reason);
    // `console.error` rather than a logger: this runs before any service has
    // built one, and a logger that itself rejects here would recurse.
    console.error(
      `[${serviceName}] unhandled promise rejection (continuing):`,
      reason instanceof Error ? (reason.stack ?? reason.message) : reason,
    );
  });
  return true;
}

/** Test seam: the guard is process-global and installs exactly once. */
export function resetUnhandledRejectionGuardForTests(): void {
  installed = false;
}
