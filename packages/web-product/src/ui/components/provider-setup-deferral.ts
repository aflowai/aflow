'use client';

/**
 * Whether the operator has chosen to carry on without a model this session.
 *
 * The setup gate opens on a workspace that cannot run, and the flow it opens
 * ends in a full page navigation — so an operator who skips would land back on
 * a workspace that still cannot run and be shown the same gate again, with no
 * way past it. The choice has to outlive the navigation, and only that one:
 * a new session asks again, because the workspace is still unfinished.
 */
const KEY = 'aflow.provider-setup.deferred';

export function isProviderSetupDeferred(): boolean {
  try {
    return window.sessionStorage.getItem(KEY) !== null;
  } catch {
    // sessionStorage unavailable — behave as if nothing was deferred, which
    // shows the gate rather than silently dropping the operator into a
    // workspace that cannot answer.
    return false;
  }
}

export function deferProviderSetup(): void {
  try {
    window.sessionStorage.setItem(KEY, '1');
  } catch {
    // Nothing to record it in. The gate reappears, which is the safe direction.
  }
}
