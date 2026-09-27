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
import {
  closeOnSignal,
  resolveListenHost,
  serve,
  type ServerComposition,
} from '@aflow/server-runtime';
import { resolveEditionDescriptor } from '@aflow/schemas';

export function start(composition: ServerComposition): void {
  const port = process.env['PORT'] ? Number(process.env['PORT']) : 3000;
  const host = resolveListenHost(resolveEditionDescriptor());

  serve(composition, { host, port })
    .then((app) => {
      closeOnSignal(app, (code) => process.exit(code));
    })
    .catch((err: unknown) => {
      // The logger belongs to an app that may never have been built.
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[server] Fatal startup error: ${message}\n`);
      if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
      process.exit(1);
    });
}
