/**
 * Phoenix API Server — the core composition root.
 *
 * This is the appliance's entrypoint and the public core's only one. The
 * hosted product runs `index.hosted.ts` instead; nothing else differs.
 */
// Must precede every other import: Sentry reads its DSN as `instrument.js` evaluates.
import './env.js';
// Must precede all other imports so Sentry can patch http/fastify before they load.
import './instrument.js';
import { coreComposition } from '@aflow/server-runtime';
import { start } from './start.js';

start(coreComposition);
