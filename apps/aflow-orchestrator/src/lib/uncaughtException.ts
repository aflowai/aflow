import { isAbruptCloseWrite, replacePoolsThatLostAConnection } from '@aflow/database';
import type { Logger } from '@aflow/observability';
import { errorContextFromUnknown } from '@aflow/schemas';

export interface UncaughtExceptionDeps {
  logger: Pick<Logger, 'warn' | 'error'>;
  consumerName: string;
  /** Ends the process once a fatal exception has been reported. */
  exit: () => void;
}

/**
 * The orchestrator's answer to an exception nothing caught.
 *
 * One is survivable: the Postgres client's write to a connection the database
 * dropped under a transaction (`replaceablePool.ts` in `@aflow/database`), and
 * a database restart produces it. Ending the process there stops every stream
 * on the machine for as long as nothing restarts it, so the client is replaced
 * instead and the next query reconnects. Anything else leaves the process in a
 * state nobody reasoned about, and still ends it for the supervisor to restart.
 */
export function createUncaughtExceptionHandler(
  deps: UncaughtExceptionDeps,
): (error: unknown) => void {
  return (error) => {
    if (isAbruptCloseWrite(error)) {
      const replaced = replacePoolsThatLostAConnection();
      deps.logger.warn(
        'The database dropped a connection under a transaction; replaced the client, and the next query reconnects',
        { consumerName: deps.consumerName, replacedClients: String(replaced) },
      );
      return;
    }
    deps.logger.error(
      'Uncaught exception; exiting so the supervisor starts the orchestrator again',
      error instanceof Error ? error : undefined,
      errorContextFromUnknown(error, { consumerName: deps.consumerName, phase: 'uncaught' }),
    );
    deps.exit();
  };
}
