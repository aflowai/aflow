import { attachSignalHandlers, type ShutdownController } from '@aflow/lib';

/**
 * Attaches the stop and drain handlers, then runs each start in turn.
 *
 * Handlers first, because a runtime claims from the moment it starts and a
 * claimed harness runs in a process group of its own, holding its credential.
 * A signal nothing handles takes its default action, which skips the exit
 * handler and leaves that group running with nothing left to end it.
 *
 * Resolves false once a signal has begun a shutdown: the starts not yet run
 * stay unrun, since the shutdown under way would not stop what they started.
 */
export async function startUnderSignals(
  controller: ShutdownController,
  starts: ReadonlyArray<() => Promise<void>>,
): Promise<boolean> {
  attachSignalHandlers({
    onShutdown: () => controller.shutdownOnce(),
    onDrain: () => controller.drainOnce(),
  });
  for (const start of starts) {
    if (controller.shuttingDown) return false;
    await start();
  }
  return !controller.shuttingDown;
}
