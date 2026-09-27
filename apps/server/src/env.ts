/**
 * The checkout's `.env`, loaded before anything can read it.
 *
 * Side-effecting, and the FIRST import of every entrypoint — ahead of even
 * `instrument.js`. Module scope is the only place this works: a function called
 * from `start()` runs after every static import has already been evaluated, so
 * anything capturing an environment variable at module scope would read the
 * value this file exists to supply before it was supplied. Sentry's DSN and the
 * invite limits are read that way.
 *
 * Loaded for a process started without `dotenv -e .env` — the workspace scripts
 * run with cwd `apps/server`, not the repository root. The repository root is
 * read first and the cwd second; neither overrides a variable already set, which
 * is how the appliance's Docker environment keeps precedence over a stray file.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadDotenv } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
const repoRootEnv = resolve(here, '../../../.env');
if (existsSync(repoRootEnv)) loadDotenv({ path: repoRootEnv });
loadDotenv();
