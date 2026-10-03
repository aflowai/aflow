/**
 * What makes this server a process.
 *
 * The runtime builds and listens; everything that only an executable may do is
 * here — choosing the port, claiming the termination signals, and deciding that
 * a failed start ends the process. The checkout's `.env` is `env.js`, which must
 * load earlier than a function call can.
 * Importing `@aflow/server-runtime` does none of it, so a test or a second
 * application that embeds the server inherits none of it either.
 */
import './env.js';
import { getRedisConnection } from '@aflow/redis';
import {
  closeOnSignal,
  resolveListenHost,
  serve,
  type ServerComposition,
} from '@aflow/server-runtime';
import { assertHostGrantOnRunningServer } from '@aflow/server-runtime/bootstrap';
import { resolveEditionDescriptor } from '@aflow/schemas';

type ServerLog = Awaited<ReturnType<typeof serve>>['log'];

/**
 * The paired machine's Redis grant belongs to the code this process runs, so it
 * is asserted on every start of this process. The one-shot that provisions the
 * stack runs once per `yarn start`, while this process restarts onto new code
 * on every edit: a grant a release added stayed refused (`NOPERM`) to the paired
 * machine until somebody restarted everything. Not fatal — everything but the
 * host lane works without it, and the log says what is missing.
 *
 * The host password in this environment only says that a host lane is set up.
 * It is never applied here: it was read when the supervisor started, so after a
 * revocation it is the revoked one. The full start (`bootstrapLocal.ts`) is the
 * start path that may set it, and creates a missing identity with it, because
 * it has just read the durable value from `instance.env`.
 */
async function assertHostGrant(log: ServerLog): Promise<void> {
  const hostLane = process.env['PHOENIX_HOST_REDIS_PASSWORD']?.trim();
  if (hostLane === undefined || hostLane === '') return;
  try {
    const { outcome } = await assertHostGrantOnRunningServer(getRedisConnection());
    if (outcome === 'absent') {
      log.warn(
        'The running Redis has no host identity, so no paired machine can connect. ' +
          'Pairing a machine, or a full start, creates it.',
      );
      return;
    }
    log.info('Asserted the host grant on the running Redis');
  } catch (err) {
    log.error(
      { err },
      'Could not assert the host grant on the running Redis: a paired machine is refused ' +
        'whatever this release added to its grant until a start of this server asserts it',
    );
  }
}

export function start(composition: ServerComposition): void {
  const port = process.env['PORT'] ? Number(process.env['PORT']) : 3000;
  const host = resolveListenHost(resolveEditionDescriptor());

  serve(composition, { host, port })
    .then(async (app) => {
      closeOnSignal(app, (code) => process.exit(code));
      await assertHostGrant(app.log);
    })
    .catch((err: unknown) => {
      // The logger belongs to an app that may never have been built.
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[server] Fatal startup error: ${message}\n`);
      if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
      process.exit(1);
    });
}
